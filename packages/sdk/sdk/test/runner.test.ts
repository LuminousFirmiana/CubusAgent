import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { AgentRecipe } from '@cubus/agent-recipe'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import type { LlmAdapter } from '@cubus/llm'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import type { Tool } from '@cubus/tool-registry'
import type { JsonRpcError, JsonRpcSuccess } from '../src/protocol.ts'
import { createRunnerMethods, SessionRuntime } from '../src/runner.ts'
import { RpcServer } from '../src/server.ts'
import { createMemoryTransport } from '../src/transport.ts'

let dir: string

function makeIdGen(prefix: string) {
  let n = 0
  return () => `${prefix}${++n}`
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

type Scenes = ConstructorParameters<typeof ScriptedAdapter>[0]

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo arguments as JSON.',
  parameters: { type: 'object' },
  execute: args => JSON.stringify(args),
}

const sdkTestRecipe: AgentRecipe<void> = {
  manifest: {
    contractVersion: 1,
    id: 'sdk-test',
    version: '1.0.0',
    displayName: 'SDK Test Agent',
    requires: [{ kind: 'llm', features: ['tool-calling'] }, { kind: 'session-log' }],
    prompt: { fragmentId: 'sdk-test/persona' },
    tools: ['echo'],
    permission: { profile: 'ask' },
  },
  async mount(ctx) {
    await ctx.plugin(systemPromptContribution({ id: 'sdk-test/persona', text: 'SDK test agent.' }))
    await ctx.plugin(toolContribution(echoTool))
  },
}

async function setup(scenes: Scenes) {
  const runtime = new SessionRuntime({
    rootDir: dir,
    host: createLocalAgentHost({ workspaceDir: dir, adapterFactory: () => new ScriptedAdapter(scenes) }),
    recipe: sdkTestRecipe,
    recipeOptions: undefined,
    generateId: makeIdGen('s'),
  })
  const transport = createMemoryTransport()
  const server = new RpcServer(transport, createRunnerMethods(runtime))
  return { runtime, transport, server }
}

/**
 * 通过协议发一次请求，按 id 关联拿到响应。
 * 不猜延迟、不读"最后一条"：轮询等到匹配该 id 的响应为止（10 秒上限）。
 * 教训：固定 setTimeout 等待在慢机器（CI）上会竞态读到上一条响应。
 */
async function rpc(transport: ReturnType<typeof createMemoryTransport>, method: string, params: Record<string, unknown> = {}, id: number | string = 1) {
  const startIndex = transport.responses.length
  transport.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    for (let i = startIndex; i < transport.responses.length; i++) {
      const message = JSON.parse(transport.responses[i]!) as { id?: number | string }
      if (message.id === id) return message as JsonRpcSuccess | JsonRpcError
    }
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('rpc timeout waiting for id ' + String(id))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-sdk-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('create -> run -> assistant text over the wire', async () => {
  const { transport } = await setup([{ steps: [{ chunk: { delta: '协议版你好' } }] }])

  const created = await rpc(transport, 'session.create') as JsonRpcSuccess
  const sessionId = (created.result as { id: string }).id
  expect(sessionId).toBe('s1')

  const run = await rpc(transport, 'session.run', { sessionId, text: '你好' }, 2) as JsonRpcSuccess
  const result = run.result as { assistantText?: string; turnEvents: unknown[] }
  expect(result.assistantText).toBe('协议版你好')

  const types = result.turnEvents.map(e => (e as { type: string }).type)
  expect(types[0]).toBe('turn/start')
  expect(types.at(-1)).toBe('turn/end')
  expect(types).toContain('assistant/message')
})

test('a tool loop runs end to end through the protocol', async () => {
  const { transport } = await setup([
    { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'echo', args: { x: 42 } }] } }] },
    { steps: [{ chunk: { delta: '工具用完了' } }] },
  ])

  const created = await rpc(transport, 'session.create') as JsonRpcSuccess
  const sessionId = (created.result as { id: string }).id
  const run = await rpc(transport, 'session.run', { sessionId, text: '调工具' }) as JsonRpcSuccess
  const result = run.result as { assistantText?: string; turnEvents: { type: string }[] }

  expect(result.assistantText).toBe('工具用完了')
  const types = result.turnEvents.map(e => e.type)
  expect(types).toContain('tool/call')
  expect(types).toContain('tool/result')
  // 工具闭环 = 两个 step
  expect(types.filter(t => t === 'step/start')).toHaveLength(2)
})

test('session.cancel interrupts the active tool and the run returns a settled turn', async () => {
  const started = deferred()
  const adapter = new ScriptedAdapter([{ steps: [{ chunk: { toolCalls: [
    { id: 'wait-1', name: 'wait', args: {} },
  ] } }] }])
  const waitTool: Tool = {
    name: 'wait',
    description: 'Wait for cancellation.',
    parameters: { type: 'object' },
    execute(_args, context) {
      started.resolve()
      return new Promise<string>((_resolve, reject) => {
        const cancel = (): void => reject(context.signal.reason)
        if (context.signal.aborted) cancel()
        else context.signal.addEventListener('abort', cancel, { once: true })
      })
    },
  }
  const recipe: AgentRecipe<void> = {
    manifest: {
      contractVersion: 1,
      id: 'cancel-test',
      version: '1.0.0',
      displayName: 'Cancel Test',
      requires: [{ kind: 'llm', features: ['tool-calling'] }, { kind: 'session-log' }],
      prompt: { fragmentId: 'cancel-test/role' },
      tools: ['wait'],
      permission: { profile: 'ask' },
    },
    async mount(ctx) {
      await ctx.plugin(systemPromptContribution({ id: 'cancel-test/role', text: 'Cancel test agent.' }))
      await ctx.plugin(toolContribution(waitTool))
    },
  }
  const runtime = new SessionRuntime({
    rootDir: dir,
    host: createLocalAgentHost({ workspaceDir: dir, adapterFactory: () => adapter }),
    recipe,
    recipeOptions: undefined,
    generateId: makeIdGen('c'),
  })
  const transport = createMemoryTransport()
  const server = new RpcServer(transport, createRunnerMethods(runtime))
  expect(server).toBeDefined()
  const created = await rpc(transport, 'session.create') as JsonRpcSuccess
  const sessionId = (created.result as { id: string }).id

  const running = rpc(transport, 'session.run', { sessionId, text: 'wait' }, 2)
  await started.promise
  const cancelled = await rpc(transport, 'session.cancel', { sessionId }, 3) as JsonRpcSuccess
  const result = await running as JsonRpcSuccess

  expect(cancelled.result).toEqual({ sessionId })
  const turn = result.result as { turnEvents: { type: string, id?: string, ok?: boolean, output?: { text: string } }[] }
  expect(turn.turnEvents.find(event => event.type === 'tool/result')).toMatchObject({
    id: 'wait-1',
    ok: false,
    output: { text: 'cancelled' },
  })
  expect(turn.turnEvents.at(-1)?.type).toBe('turn/end')
})

test('session.list returns created sessions; unknown session errors', async () => {
  const { transport } = await setup([{ steps: [{ chunk: { delta: 'x' } }] }])

  await rpc(transport, 'session.create', {}, 1)
  await rpc(transport, 'session.create', {}, 2)
  const list = await rpc(transport, 'session.list', {}, 3) as JsonRpcSuccess
  expect(list.result).toEqual([
    { id: 's1', logPath: join(dir, 's1', 'session.jsonl') },
    { id: 's2', logPath: join(dir, 's2', 'session.jsonl') },
  ])

  const missing = await rpc(transport, 'session.run', { sessionId: 'nope', text: 'x' }, 4) as JsonRpcError
  expect(missing.error.code).toBe(-32603)
  expect(missing.error.message).toContain('session not found')
})

test('invalid params on the wire return -32602', async () => {
  const { transport } = await setup([{ steps: [{ chunk: { delta: 'x' } }] }])

  const bad = await rpc(transport, 'session.run', { sessionId: 123 }, 9) as JsonRpcError
  expect(bad.error.code).toBe(-32602)
})

test('two sessions are isolated: each has its own log and model state', async () => {
  const { transport } = await setup([{ steps: [{ chunk: { delta: '一次' } }] }])

  const a = await rpc(transport, 'session.create', {}, 1) as JsonRpcSuccess
  const b = await rpc(transport, 'session.create', {}, 2) as JsonRpcSuccess
  const idA = (a.result as { id: string }).id
  const idB = (b.result as { id: string }).id

  const runA = await rpc(transport, 'session.run', { sessionId: idA, text: 'x' }, 3) as JsonRpcSuccess
  const runB = await rpc(transport, 'session.run', { sessionId: idB, text: 'x' }, 4) as JsonRpcSuccess
  expect((runA.result as { assistantText?: string }).assistantText).toBe('一次')
  expect((runB.result as { assistantText?: string }).assistantText).toBe('一次')
})

test('concurrent runs on one session each wait for and return their own complete turn', async () => {
  const firstStarted = deferred()
  const releaseFirst = deferred()
  let call = 0
  const adapter: LlmAdapter = {
    provider: 'queue-test',
    model: 'queue-model',
    async *stream() {
      call++
      if (call === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
        yield { delta: '第一轮' }
        return
      }
      yield { delta: '第二轮' }
    },
  }
  const runtime = new SessionRuntime({
    rootDir: dir,
    host: createLocalAgentHost({ workspaceDir: dir, adapterFactory: () => adapter }),
    recipe: sdkTestRecipe,
    recipeOptions: undefined,
    generateId: makeIdGen('q'),
  })
  const session = await runtime.create()

  const first = runtime.run(session.id, '一')
  await firstStarted.promise
  const second = runtime.run(session.id, '二')
  releaseFirst.resolve()

  const [firstResult, secondResult] = await Promise.all([first, second])
  expect(firstResult.assistantText).toBe('第一轮')
  expect(secondResult.assistantText).toBe('第二轮')
  expect(firstResult.turnEvents.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(secondResult.turnEvents.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(firstResult.turnEvents.find(event => event.type === 'user/message')?.content[0]?.text).toBe('一')
  expect(secondResult.turnEvents.find(event => event.type === 'user/message')?.content[0]?.text).toBe('二')
})

/** 声明式 recipe：走协商路径，装配快照会落进真实 JSONL 日志。 */
const declarativeTestRecipe: AgentRecipe<void> = {
  manifest: {
    id: 'sdk-declarative',
    version: '3.0.0',
    displayName: 'SDK Declarative Agent',
    contractVersion: 1,
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      // 与真实产品一致：隔离信息可选但必须记录进快照。
      { kind: 'sandbox', required: false },
    ],
    prompt: { fragmentId: 'sdk/persona' },
    tools: [],
    permission: { profile: 'ask' },
  },
  async mount(ctx) {
    await ctx.plugin(systemPromptContribution({ id: 'sdk/persona', text: 'You are a test agent.' }))
  },
}

test('a declarative recipe records its assembly snapshot as the first log line', async () => {
  const runtime = new SessionRuntime({
    rootDir: dir,
    host: createLocalAgentHost({
      workspaceDir: dir,
      adapterFactory: () => new ScriptedAdapter([{ steps: [{ chunk: { delta: 'ok' } }] }]),
    }),
    recipe: declarativeTestRecipe,
    recipeOptions: undefined,
    permissionProfile: 'deny',
    generateId: makeIdGen('m'),
  })

  const session = await runtime.create()
  const result = await runtime.run(session.id, 'go')

  // 真实文件：第一行必须是装配快照，且容量/策略来自协商与 app 覆盖。
  const lines = readFileSync(session.logPath, 'utf8').trim().split('\n')
  const first = JSON.parse(lines[0] ?? '{}') as { type?: string, mount?: unknown }
  expect(first.type).toBe('session/mount')
  expect(first.mount).toEqual({
    recipe: { id: 'sdk-declarative', version: '3.0.0', contractVersion: 1 },
    capabilities: [
      { kind: 'llm', provider: 'local-adapter', features: ['streaming', 'tool-calling'] },
      { kind: 'sandbox', provider: 'local-unconfined', features: ['unconfined'] },
      { kind: 'session-log', provider: 'jsonl', features: ['live-subscribe'] },
    ],
    optionalMissing: [],
    permission: { profile: 'deny', source: 'app' },
    config: null,
  })

  // 装配成功后会话照常运行；快照不是模型可见内容。
  expect(result.assistantText).toBe('ok')
  const events = lines.map(line => JSON.parse(line) as { type: string })
  expect(events.filter(event => event.type === 'session/mount')).toHaveLength(1)
  expect(events.at(-1)?.type).toBe('turn/end')
})

/** 轮询等待条件成立（不用固定延迟猜时间）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('waitFor timed out')
}

test('mountSnapshot exposes the assembly snapshot and rejects unknown sessions', async () => {
  const runtime = new SessionRuntime({
    rootDir: dir,
    host: createLocalAgentHost({
      workspaceDir: dir,
      adapterFactory: () => new ScriptedAdapter([{ steps: [{ chunk: { delta: 'ok' } }] }]),
    }),
    recipe: declarativeTestRecipe,
    recipeOptions: undefined,
    generateId: makeIdGen('m'),
  })

  const session = await runtime.create()
  const mount = await runtime.mountSnapshot(session.id)

  expect(mount?.recipe.id).toBe('sdk-declarative')
  expect(mount?.permission).toEqual({ profile: 'ask', source: 'manifest' })
  // 本地 Host 的隔离状态如实可查：这就是 C2 的"装配期可见"。
  expect(mount?.capabilities).toContainEqual({
    kind: 'sandbox',
    provider: 'local-unconfined',
    features: ['unconfined'],
  })

  await expect(runtime.mountSnapshot('missing-session')).rejects.toThrow('session not found')
})

test('subscribe streams events while the run is still in flight', async () => {
  const gate = deferred()
  const { runtime } = await setup([
    { steps: [{ chunk: { delta: 'first' }, hold: gate.promise }, { chunk: { delta: 'second' } }] },
  ])
  const session = await runtime.create()
  const seen: string[] = []
  const unsubscribe = runtime.subscribe(session.id, event => {
    seen.push(event.type)
  })

  const operation = runtime.run(session.id, 'go')
  await waitFor(() => seen.includes('assistant/chunk'))
  // 模型流还卡在 hold 上：此刻已收到事件，说明是实时流而不是结束后的回放。
  expect(seen).not.toContain('turn/end')

  gate.resolve()
  await operation
  expect(seen).toContain('turn/end')
  unsubscribe()
})

test('subscribe stops delivering after unsubscribe and rejects unknown sessions', async () => {
  const { runtime } = await setup([{ steps: [{ chunk: { delta: 'ok' } }] }])
  const session = await runtime.create()
  const seen: string[] = []
  const unsubscribe = runtime.subscribe(session.id, event => {
    seen.push(event.type)
  })
  unsubscribe()

  await runtime.run(session.id, 'go')
  expect(seen).toEqual([])

  expect(() => runtime.subscribe('missing-session', () => {})).toThrow('session not found')
})
