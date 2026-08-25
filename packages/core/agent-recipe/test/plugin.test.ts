import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import type { LlmAdapter, LlmRequest } from '@cubus/llm'
import type { SessionEvent, SessionLog, SessionLogReadResult } from '@cubus/session'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import type { Tool } from '@cubus/tool-registry'
import { createAgentRuntimePlugin } from '../src/index.ts'
import type { AgentHost, AgentRecipe } from '../src/index.ts'

class MemorySessionLog implements SessionLog {
  readonly events: SessionEvent[] = []

  async append(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }

  async read(): Promise<SessionLogReadResult> {
    return { events: [...this.events], truncated: false }
  }
}

test('mounts Host then Recipe and runs with the Recipe capability snapshot', async () => {
  const order: string[] = []
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
  const log = new MemorySessionLog()
  const host: AgentHost = {
    mount(ctx) {
      order.push('host')
      ctx.provide('llm', adapter)
      ctx.provide('sessionLog', log)
    },
  }
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
    manifest: { id: 'reference-agent', version: '1.0.0', displayName: 'Reference Agent' },
    async mount(ctx) {
      order.push('recipe')
      await ctx.plugin(systemPromptContribution({ id: 'role', text: 'Use general-purpose tools.' }))
      await ctx.plugin(toolContribution(addNumbers))
    },
  }
  const ctx = new Context()

  await ctx.plugin(createAgentRuntimePlugin({
    host,
    recipe,
    recipeOptions: undefined,
    session: Object.freeze({ id: 's1', directory: '/sessions/s1', logPath: '/sessions/s1/session.jsonl' }),
  }))
  await ctx.get('loop')!.submit([{ type: 'text', text: 'Add 2 and 3.' }])

  expect(order).toEqual(['host', 'recipe'])
  expect(requests[0]?.systemPrompt).toBe('Use general-purpose tools.')
  expect(requests[0]?.tools?.map(tool => tool.name)).toEqual(['add_numbers'])
  expect(log.events.find(event => event.type === 'tool/result')).toMatchObject({
    type: 'tool/result',
    id: 'sum-1',
    ok: true,
    output: { text: '5' },
  })
  expect(log.events.findLast(event => event.type === 'assistant/message')?.content[0]?.text).toBe('The sum is 5.')
})

test('disposing the composition root removes Host, Recipe, services, and Loop', async () => {
  const adapter: LlmAdapter = {
    provider: 'dispose-test',
    model: 'none',
    async *stream() {},
  }
  const host: AgentHost = {
    mount(ctx) {
      ctx.provide('llm', adapter)
      ctx.provide('sessionLog', new MemorySessionLog())
    },
  }
  const recipe: AgentRecipe<void> = {
    manifest: { id: 'disposable', version: '1.0.0', displayName: 'Disposable' },
    async mount(ctx) {
      await ctx.plugin(systemPromptContribution({ id: 'role', text: 'Temporary.' }))
    },
  }
  const ctx = new Context()
  const runtime = ctx.plugin(createAgentRuntimePlugin({
    host,
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
    manifest: { id: '', version: '1.0.0', displayName: 'Broken' },
    mount() {},
  }
  const host: AgentHost = { mount() {} }

  expect(() => createAgentRuntimePlugin({
    host,
    recipe,
    recipeOptions: undefined,
    session: { id: 's1', directory: '/tmp/s1', logPath: '/tmp/s1/session.jsonl' },
  })).toThrow('agent recipe manifest id must not be empty')
})
