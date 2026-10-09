import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import type { SessionEvent, SessionLog, SessionLogReadResult } from '@cubus/session'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import type { Tool } from '@cubus/tool-registry'
import {
  AssemblyMismatchError,
  CapabilityNegotiationError,
  compareAssemblyIdentity,
  createAgentRuntimePlugin,
  MountSnapshotError,
  RecipeDeclarationMismatchError,
} from '../src/index.ts'
import type {
  AgentHost,
  AgentRecipe,
  AgentRecipeManifest,
  AgentSessionDescriptor,
  HostCapabilityOffering,
} from '../src/index.ts'
import type { MountSnapshot } from '@cubus/session'

class MemorySessionLog implements SessionLog {
  readonly events: SessionEvent[] = []

  async append(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }

  async read(): Promise<SessionLogReadResult> {
    return { events: [...this.events], truncated: false }
  }
}

const descriptor: AgentSessionDescriptor = {
  id: 's1',
  directory: '/sessions/s1',
  logPath: '/sessions/s1/session.jsonl',
}

const adapter: LlmAdapter = {
  provider: 'assembly-test',
  model: 'scripted',
  async *stream() {},
}

const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a file.',
  parameters: { type: 'object' },
  execute: () => 'contents',
}

/** 测试 Host：声明 llm + session-log，可选追加额外 offerings（工厂，便于复用同一个 log）。 */
function makeHost(options: { extra?: (context: { log: MemorySessionLog, mounted: string[] }) => HostCapabilityOffering[] } = {}) {
  const log = new MemorySessionLog()
  const mounted: string[] = []
  const offerings: HostCapabilityOffering[] = [
    {
      kind: 'llm',
      provider: 'local-adapter',
      features: ['tool-calling', 'streaming'],
      mount(ctx) {
        mounted.push('llm')
        ctx.provide('llm', adapter)
      },
    },
    {
      kind: 'session-log',
      provider: 'jsonl',
      features: ['live-subscribe'],
      mount(ctx) {
        mounted.push('session-log')
        ctx.provide('sessionLog', log)
      },
    },
    ...(options.extra?.({ log, mounted }) ?? []),
  ]
  const host: AgentHost = {
    capabilities: () => offerings,
    async mount(ctx, session, selection) {
      for (const offering of selection ?? offerings) await offering.mount(ctx, session)
    },
  }
  return { host, log, mounted }
}

/** 声明式 recipe：默认注册 prompt 片段 role 与工具 read_file。 */
function declarativeRecipe<Options = void>(
  overrides: Partial<AgentRecipeManifest> = {},
  mountFn?: AgentRecipe<Options>['mount'],
): AgentRecipe<Options> {
  return {
    manifest: {
      id: 'declarative-agent',
      version: '2.0.0',
      displayName: 'Declarative Agent',
      contractVersion: 1,
      requires: [{ kind: 'llm', features: ['tool-calling'] }, { kind: 'session-log' }],
      prompt: { fragmentId: 'role' },
      tools: ['read_file'],
      permission: { profile: 'ask' },
      ...overrides,
    },
    async mount(ctx) {
      if (mountFn !== undefined) return await mountFn(ctx, undefined as Options)
      await ctx.plugin(systemPromptContribution({ id: 'role', text: 'Be helpful.' }))
      await ctx.plugin(toolContribution(readFileTool))
    },
  }
}

test('records the assembly snapshot as the very first log event', async () => {
  const harness = makeHost()
  const ctx = new Context()

  await ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe: declarativeRecipe(),
    recipeOptions: undefined,
    session: descriptor,
  }))

  expect(harness.log.events).toHaveLength(1)
  expect(harness.log.events[0]).toEqual({
    type: 'session/mount',
    mount: {
      recipe: { id: 'declarative-agent', version: '2.0.0', contractVersion: 1 },
      capabilities: [
        { kind: 'llm', provider: 'local-adapter', features: ['streaming', 'tool-calling'] },
        { kind: 'session-log', provider: 'jsonl', features: ['live-subscribe'] },
      ],
      optionalMissing: [],
      permission: { profile: 'ask', source: 'manifest' },
      config: null,
    },
  })
})

test('mounts only the negotiated offerings, not every capability the host can offer', async () => {
  const harness = makeHost({
    extra: ({ mounted }) => [{
      kind: 'git',
      provider: 'git-cli',
      features: ['read-only-report'],
      mount() {
        mounted.push('git')
      },
    }],
  })
  const ctx = new Context()

  await ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe: declarativeRecipe(),
    recipeOptions: undefined,
    session: descriptor,
  }))

  expect(harness.mounted).toEqual(['llm', 'session-log'])
})

test('an app-level permission profile overrides the manifest default and is recorded as such', async () => {
  const harness = makeHost()
  const ctx = new Context()

  await ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe: declarativeRecipe(),
    recipeOptions: undefined,
    session: descriptor,
    permissionProfile: 'deny',
  }))

  const event = harness.log.events[0]
  expect(event?.type === 'session/mount' ? event.mount.permission : undefined).toEqual({
    profile: 'deny',
    source: 'app',
  })
})

test('a missing required capability fails before mounting anything and writes no log', async () => {
  const harness = makeHost()
  const ctx = new Context()
  const recipe = declarativeRecipe({
    requires: [{ kind: 'sandbox', features: ['network-deny'] }],
  })

  let caught: unknown
  try {
    await ctx.plugin(createAgentRuntimePlugin({
      host: harness.host,
      recipe,
      recipeOptions: undefined,
      session: descriptor,
    }))
  } catch (error) {
    caught = error
  }

  const error = caught as CapabilityNegotiationError
  expect(error).toBeInstanceOf(CapabilityNegotiationError)
  expect(error.reason).toBe('missing')
  expect(error.message).toContain('requires capability sandbox[network-deny]')
  expect(error.message).toContain('host offers: llm:local-adapter[tool-calling,streaming]')
  expect(harness.mounted).toEqual([])
  expect(harness.log.events).toEqual([])
})

test('an ambiguous capability fails until the app pins one provider', async () => {
  const harness = makeHost({
    extra: ({ log, mounted }) => [{
      kind: 'session-log',
      provider: 'docker-jsonl',
      features: ['live-subscribe'],
      mount(ctx) {
        mounted.push('docker-jsonl')
        ctx.provide('sessionLog', log)
      },
    }],
  })

  const rejected = new Context()
  let caught: unknown
  try {
    await rejected.plugin(createAgentRuntimePlugin({
      host: harness.host,
      recipe: declarativeRecipe(),
      recipeOptions: undefined,
      session: descriptor,
    }))
  } catch (error) {
    caught = error
  }
  const error = caught as CapabilityNegotiationError
  expect(error).toBeInstanceOf(CapabilityNegotiationError)
  expect(error.reason).toBe('ambiguous')
  expect(error.message).toContain('session-log:jsonl, session-log:docker-jsonl')

  const pinned = new Context()
  await pinned.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe: declarativeRecipe(),
    recipeOptions: undefined,
    session: descriptor,
    capabilityPins: { 'session-log': 'docker-jsonl' },
  }))

  expect(harness.mounted).toContain('docker-jsonl')
  const event = harness.log.events[0]
  const capabilities = event?.type === 'session/mount' ? event.mount.capabilities : []
  expect(capabilities).toContainEqual({ kind: 'session-log', provider: 'docker-jsonl', features: ['live-subscribe'] })
})

test('a declarative recipe against a host without capabilities() fails with a clear message', async () => {
  const log = new MemorySessionLog()
  const legacyHost: AgentHost = {
    mount(ctx) {
      ctx.provide('llm', adapter)
      ctx.provide('sessionLog', log)
    },
  }
  // 协商发生在建插件时（同步），因此失败早于任何 ctx 装配动作。
  expect(() => createAgentRuntimePlugin({
    host: legacyHost,
    recipe: declarativeRecipe(),
    recipeOptions: undefined,
    session: descriptor,
  })).toThrow('does not implement capabilities()')
  expect(log.events).toEqual([])
})

test('declared tools must match the registered set exactly', async () => {
  const harness = makeHost()
  const ctx = new Context()
  const recipe = declarativeRecipe({ tools: ['read_file', 'write_file'] })

  let caught: unknown
  try {
    await ctx.plugin(createAgentRuntimePlugin({
      host: harness.host,
      recipe,
      recipeOptions: undefined,
      session: descriptor,
    }))
  } catch (error) {
    caught = error
  }

  const error = caught as RecipeDeclarationMismatchError
  expect(error).toBeInstanceOf(RecipeDeclarationMismatchError)
  expect(error.message).toContain('declared but not registered [write_file]')
  expect(error.message).toContain('registered but not declared (none)')
  // 声明校验失败时不写快照：日志里不能出现"装配成功"的证据。
  expect(harness.log.events).toEqual([])
})

test('a config that is not a plain JSON value is rejected before the snapshot is written', async () => {
  const harness = makeHost()
  const ctx = new Context()

  await expect(ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe: declarativeRecipe<{ fs: MemorySessionLog }>({ tools: ['read_file'] }),
    recipeOptions: { fs: new MemorySessionLog() },
    session: descriptor,
  }))).rejects.toBeInstanceOf(MountSnapshotError)
  expect(harness.log.events).toEqual([])
})

test('a recipe that requires real isolation fails to assemble on an unconfined host', async () => {
  const harness = makeHost({
    extra: ({ mounted }) => [{
      kind: 'sandbox',
      provider: 'local-unconfined',
      features: ['unconfined'],
      mount() {
        mounted.push('sandbox')
      },
    }],
  })
  const ctx = new Context()
  const recipe = declarativeRecipe({
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      { kind: 'sandbox', features: ['fs-isolation', 'network-deny'] },
    ],
  })

  let caught: unknown
  try {
    await ctx.plugin(createAgentRuntimePlugin({
      host: harness.host,
      recipe,
      recipeOptions: undefined,
      session: descriptor,
    }))
  } catch (error) {
    caught = error
  }

  const error = caught as CapabilityNegotiationError
  expect(error).toBeInstanceOf(CapabilityNegotiationError)
  expect(error.reason).toBe('missing')
  expect(error.message).toContain('requires capability sandbox[fs-isolation,network-deny]')
  expect(error.message).toContain('sandbox:local-unconfined[unconfined]')
  // 关键：不静默降级 —— 什么都没挂、日志里也没有"装配成功"的证据。
  expect(harness.mounted).toEqual([])
  expect(harness.log.events).toEqual([])
})

test('an optional sandbox requirement records the unconfined provider in the snapshot', async () => {
  const harness = makeHost({
    extra: ({ mounted }) => [{
      kind: 'sandbox',
      provider: 'local-unconfined',
      features: ['unconfined'],
      mount() {
        mounted.push('sandbox')
      },
    }],
  })
  const ctx = new Context()
  const recipe = declarativeRecipe({
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      { kind: 'sandbox', required: false },
    ],
  })

  await ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe,
    recipeOptions: undefined,
    session: descriptor,
  }))

  const event = harness.log.events[0]
  const capabilities = event?.type === 'session/mount' ? event.mount.capabilities : []
  expect(capabilities).toContainEqual({ kind: 'sandbox', provider: 'local-unconfined', features: ['unconfined'] })
  expect(event?.type === 'session/mount' ? event.mount.optionalMissing : []).toEqual([])
})

test('optional capabilities the host cannot provide are recorded in the snapshot', async () => {
  const harness = makeHost()
  const ctx = new Context()
  const recipe = declarativeRecipe({
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      { kind: 'git', required: false },
      { kind: 'sandbox', features: ['network-deny'], required: false },
    ],
  })

  await ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe,
    recipeOptions: undefined,
    session: descriptor,
  }))

  const event = harness.log.events[0]
  expect(event?.type === 'session/mount' ? event.mount.optionalMissing : undefined).toEqual(['git', 'sandbox'])
})

test('the effective budget comes from the app or the manifest and is recorded in the snapshot', async () => {
  const harness = makeHost()
  const ctx = new Context()

  await ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe: declarativeRecipe({ budget: { maxSteps: 40, maxToolCalls: 60, maxDurationMs: 600_000 } }),
    recipeOptions: undefined,
    session: descriptor,
    // app 只覆盖一项：其余字段仍取 manifest 默认（逐字段合并由 app 完成）
    budget: { maxSteps: 3 },
  }))

  const event = harness.log.events[0]
  expect(event?.type === 'session/mount' ? event.mount.budget : undefined).toEqual({ maxSteps: 3 })
  expect(ctx.get('budget')).toBeDefined()

  // 没有预算的装配不挂预算插件，快照里也没有这个字段
  const plainHarness = makeHost()
  const plainCtx = new Context()
  await plainCtx.plugin(createAgentRuntimePlugin({
    host: plainHarness.host,
    recipe: declarativeRecipe(),
    recipeOptions: undefined,
    session: descriptor,
  }))
  const plainEvent = plainHarness.log.events[0]
  expect(plainEvent?.type === 'session/mount' ? 'budget' in plainEvent.mount : true).toBe(false)
  expect(plainCtx.get('budget')).toBeUndefined()
})

test('assembly identity compares recipe, capabilities, permission and budget', () => {
  const base: MountSnapshot = {
    recipe: { id: 'r', version: '1.0.0', contractVersion: 1 },
    capabilities: [{ kind: 'llm', provider: 'a', features: [] }, { kind: 'fs', provider: 'local', features: [] }],
    optionalMissing: [],
    permission: { profile: 'ask', source: 'manifest' as const },
    budget: { maxSteps: 5 },
    config: null,
  }

  expect(compareAssemblyIdentity(base, base)).toEqual([])
  // capabilities 顺序无关
  expect(compareAssemblyIdentity(base, {
    ...base,
    capabilities: [{ kind: 'fs', provider: 'local', features: [] }, { kind: 'llm', provider: 'a', features: [] }],
  })).toEqual([])
  // 换 provider / 换 recipe / 换权限档 / 换预算都算不一致
  expect(compareAssemblyIdentity(base, {
    ...base,
    capabilities: [{ kind: 'llm', provider: 'b', features: [] }, { kind: 'fs', provider: 'local', features: [] }],
  })[0]).toContain('capabilities')
  expect(compareAssemblyIdentity(base, { ...base, recipe: { id: 'r', version: '2.0.0', contractVersion: 1 } })[0])
    .toContain('recipe: r@1.0.0 -> r@2.0.0')
  expect(compareAssemblyIdentity(base, { ...base, permission: { profile: 'deny', source: 'app' as const } })[0])
    .toContain('permission: ask -> deny')
  const { budget: _droppedBudget, ...withoutBudget } = base
  expect(compareAssemblyIdentity(base, withoutBudget)[0]).toContain('budget')

  const error = new AssemblyMismatchError('r', ['capabilities: [fs:local] -> [fs:docker]'])
  expect(error.message).toContain('start a new session instead of silently changing the environment')
  expect(error.differences).toEqual(['capabilities: [fs:local] -> [fs:docker]'])
})

test('a recipe that fails to mount leaves no snapshot and rolls back the host capabilities', async () => {
  const harness = makeHost()
  const ctx = new Context()
  const recipe = declarativeRecipe({}, async () => {
    throw new Error('recipe mount failed')
  })

  await expect(ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe,
    recipeOptions: undefined,
    session: descriptor,
  }))).rejects.toThrow('recipe mount failed')

  // 没有快照 = 日志里没有"装配成功"的证据（快照存在 ⟺ 装配成功）。
  expect(harness.log.events).toEqual([])
  // cordis 回卷：已经挂上的 Host 能力与内核服务全部卸载。
  expect(ctx.get('llm')).toBeUndefined()
  expect(ctx.get('sessionLog')).toBeUndefined()
  expect(ctx.get('loop')).toBeUndefined()
})
