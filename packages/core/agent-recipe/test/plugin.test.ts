import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import type { LlmAdapter, LlmRequest } from '@cubus/llm'
import type { SessionEvent, SessionLog, SessionLogReadResult } from '@cubus/session'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import type { Tool } from '@cubus/tool-registry'
import { createAgentRuntimePlugin, RecipeManifestError } from '../src/index.ts'
import type { AgentHost, AgentRecipe, HostCapabilityOffering } from '../src/index.ts'

class MemorySessionLog implements SessionLog {
  readonly events: SessionEvent[] = []

  async append(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }

  async read(): Promise<SessionLogReadResult> {
    return { events: [...this.events], truncated: false }
  }
}

/** 测试 Host：声明 llm + session-log 两项能力。 */
function makeHost(adapter: LlmAdapter): { host: AgentHost, log: MemorySessionLog, order: string[] } {
  const log = new MemorySessionLog()
  const order: string[] = []
  const offerings: readonly HostCapabilityOffering[] = [
    {
      kind: 'llm',
      provider: 'test-adapter',
      features: ['tool-calling'],
      mount(ctx) {
        ctx.provide('llm', adapter)
      },
    },
    {
      kind: 'session-log',
      provider: 'memory',
      features: [],
      mount(ctx) {
        ctx.provide('sessionLog', log)
      },
    },
  ]
  return {
    log,
    order,
    host: {
      capabilities: () => offerings,
      async mount(ctx, session, selection) {
        order.push('host')
        for (const offering of selection ?? offerings) await offering.mount(ctx, session)
      },
    },
  }
}

test('mounts Host then Recipe and runs with the Recipe capability snapshot', async () => {
  const requests: LlmRequest[] = []
  let modelCall = 0
  const adapter: LlmAdapter = {
    provider: 'recipe-test',
    model: 'scripted',
    async *stream(request) {
      requests.push(request)
      modelCall += 1
      if (modelCall === 1) {
        yield { toolCalls: [{ id: 'sum-1', name: 'add_numbers', args: { a: 2, b: 3 } }] }
        return
      }
      yield { delta: 'The sum is 5.' }
    },
  }
  const harness = makeHost(adapter)
  const addNumbers: Tool = {
    name: 'add_numbers',
    description: 'Add two numbers.',
    parameters: { type: 'object' },
    execute(args) {
      const input = args as { a: number, b: number }
      return String(input.a + input.b)
    },
  }
  const recipe: AgentRecipe<void> = {
    manifest: {
      contractVersion: 1,
      id: 'reference-agent',
      version: '1.0.0',
      displayName: 'Reference Agent',
      requires: [{ kind: 'llm', features: ['tool-calling'] }, { kind: 'session-log' }],
      prompt: { fragmentId: 'role' },
      tools: ['add_numbers'],
      permission: { profile: 'ask' },
    },
    async mount(ctx) {
      harness.order.push('recipe')
      await ctx.plugin(systemPromptContribution({ id: 'role', text: 'Use general-purpose tools.' }))
      await ctx.plugin(toolContribution(addNumbers))
    },
  }
  const ctx = new Context()

  await ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe,
    recipeOptions: undefined,
    session: Object.freeze({ id: 's1', directory: '/sessions/s1', logPath: '/sessions/s1/session.jsonl' }),
  }))
  await ctx.get('loop')!.submit([{ type: 'text', text: 'Add 2 and 3.' }])

  expect(harness.order).toEqual(['host', 'recipe'])
  expect(requests[0]?.systemPrompt).toBe('Use general-purpose tools.')
  expect(requests[0]?.tools?.map(tool => tool.name)).toEqual(['add_numbers'])
  expect(harness.log.events.find(event => event.type === 'tool/result')).toMatchObject({
    type: 'tool/result',
    id: 'sum-1',
    ok: true,
    output: { text: '5' },
  })
  expect(harness.log.events.findLast(event => event.type === 'assistant/message')?.content[0]?.text).toBe('The sum is 5.')
  // 装配快照是日志第一条，且记录协商结果。
  expect(harness.log.events[0]).toMatchObject({
    type: 'session/mount',
    mount: {
      capabilities: [
        { kind: 'llm', provider: 'test-adapter' },
        { kind: 'session-log', provider: 'memory' },
      ],
    },
  })
})

test('disposing the composition root removes Host, Recipe, services, and Loop', async () => {
  const adapter: LlmAdapter = {
    provider: 'dispose-test',
    model: 'none',
    async *stream() {},
  }
  const harness = makeHost(adapter)
  const recipe: AgentRecipe<void> = {
    manifest: {
      contractVersion: 1,
      id: 'disposable',
      version: '1.0.0',
      displayName: 'Disposable',
      requires: [{ kind: 'llm' }, { kind: 'session-log' }],
      prompt: { fragmentId: 'role' },
      tools: [],
      permission: { profile: 'allow' },
    },
    async mount(ctx) {
      await ctx.plugin(systemPromptContribution({ id: 'role', text: 'Temporary.' }))
    },
  }
  const ctx = new Context()
  const runtime = ctx.plugin(createAgentRuntimePlugin({
    host: harness.host,
    recipe,
    recipeOptions: undefined,
    session: { id: 's1', directory: '/tmp/s1', logPath: '/tmp/s1/session.jsonl' },
  }))
  await runtime

  expect(ctx.get('loop')).toBeDefined()
  expect(ctx.get('llm')).toBe(adapter)
  expect(ctx.get('sessionLog')).toBeDefined()
  expect(ctx.get('systemPrompt')).toBeDefined()
  expect(ctx.get('tools')).toBeDefined()

  await runtime.dispose()

  expect(ctx.get('loop')).toBeUndefined()
  expect(ctx.get('llm')).toBeUndefined()
  expect(ctx.get('sessionLog')).toBeUndefined()
  expect(ctx.get('systemPrompt')).toBeUndefined()
  expect(ctx.get('tools')).toBeUndefined()
})

test('rejects an incomplete Recipe manifest before mounting any effects', () => {
  const recipe: AgentRecipe<void> = {
    manifest: {
      contractVersion: 1,
      id: '',
      version: '1.0.0',
      displayName: 'Broken',
      requires: [{ kind: 'llm' }],
      prompt: { fragmentId: 'role' },
      tools: [],
      permission: { profile: 'ask' },
    },
    mount() {},
  }
  const adapter: LlmAdapter = { provider: 'x', model: 'y', async *stream() {} }
  const harness = makeHost(adapter)

  expect(() => createAgentRuntimePlugin({
    host: harness.host,
    recipe,
    recipeOptions: undefined,
    session: { id: 's1', directory: '/tmp/s1', logPath: '/tmp/s1/session.jsonl' },
  })).toThrow(RecipeManifestError)
  expect(harness.order).toEqual([])
})
