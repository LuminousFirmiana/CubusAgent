import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { ScriptedAdapter } from '@cubus/llm'
import type { LlmAdapter } from '@cubus/llm'
import { jsonlSessionPlugin } from '@cubus/session-jsonl'
import { systemPromptContribution, systemPromptPlugin } from '@cubus/system-prompt'
import { toolContribution, toolRegistryPlugin } from '@cubus/tool-registry'
import type { Tool } from '@cubus/tool-registry'
import { agentLoopPlugin } from '../src/plugin.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-plugin-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 供应商插件：挂载一个 ctx.llm 实现（每个插件有自己的 fiber 身份）。 */
function llmProviderPlugin(adapter: LlmAdapter) {
  return {
    name: 'llm-provider',
    apply(ctx: Context) {
      ctx.provide('llm', adapter)
    },
  }
}

async function lastAssistantText(ctx: Context): Promise<string | undefined> {
  const log = ctx.get('sessionLog')
  if (!log) return undefined
  const { events } = await log.read()
  return events.findLast(e => e.type === 'assistant/message')?.content[0]?.text
}

test('mounts as a plugin, waits for llm, and drives a turn through the log', async () => {
  const ctx = new Context()
  const adapter = new ScriptedAdapter([{ steps: [{ chunk: { delta: '插件版你好' } }] }])

  await ctx.plugin(llmProviderPlugin(adapter))
  await ctx.plugin(jsonlSessionPlugin, { path: join(dir, 'a.jsonl') })
  await ctx.plugin(agentLoopPlugin, {})

  const loop = ctx.get('loop')
  expect(loop).toBeDefined()
  await loop!.submit([{ type: 'text', text: '你好' }])

  expect(await lastAssistantText(ctx)).toBe('插件版你好')
})

test('swapping the provider plugin re-mounts the loop with the new adapter', async () => {
  const ctx = new Context()
  const adapterA = new ScriptedAdapter([{ steps: [{ chunk: { delta: 'A 回答' } }] }])
  const adapterB = new ScriptedAdapter([{ steps: [{ chunk: { delta: 'B 回答' } }] }])

  const providerA = ctx.plugin(llmProviderPlugin(adapterA))
  await ctx.plugin(jsonlSessionPlugin, { path: join(dir, 'b.jsonl') })
  const loopFiber = ctx.plugin(agentLoopPlugin, {})
  await Promise.all([providerA, loopFiber])

  await ctx.get('loop')!.submit([{ type: 'text', text: '谁在' }])
  expect(await lastAssistantText(ctx)).toBe('A 回答')

  // 换供应商 = 拆掉 provider A 插件、挂上 provider B 插件
  await providerA.dispose()
  await ctx.plugin(llmProviderPlugin(adapterB))
  await loopFiber // 循环插件因 inject 依赖变化自动重挂

  await ctx.get('loop')!.submit([{ type: 'text', text: '现在谁在' }])
  expect(await lastAssistantText(ctx)).toBe('B 回答')
})

test('unmounting the loop plugin leaves zero residue', async () => {
  const ctx = new Context()
  const adapter = new ScriptedAdapter([{ steps: [{ chunk: { delta: 'x' } }] }])

  await ctx.plugin(llmProviderPlugin(adapter))
  const sessionFiber = ctx.plugin(jsonlSessionPlugin, { path: join(dir, 'c.jsonl') })
  await sessionFiber
  const loopFiber = ctx.plugin(agentLoopPlugin, {})
  await loopFiber
  expect(ctx.get('loop')).toBeDefined()
  expect(ctx.get('sessionLog')).toBeDefined()

  await loopFiber.dispose()

  expect(ctx.get('loop')).toBeUndefined()
  expect(ctx.get('sessionLog')).toBeDefined()

  await sessionFiber.dispose()
  expect(ctx.get('sessionLog')).toBeUndefined()
})

test('uses one prompt/tool snapshot for request and execution', async () => {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolRegistryPlugin)
  await ctx.plugin(systemPromptContribution({ id: 'role', text: 'Use registered tools.' }))

  const lookupTool: Tool = {
    name: 'lookup',
    description: 'Look up one known fact.',
    parameters: { type: 'object' },
    execute: () => 'snapshot result',
  }
  const lookupFiber = ctx.plugin(toolContribution(lookupTool))
  await lookupFiber

  const requests: Parameters<LlmAdapter['stream']>[0][] = []
  let call = 0
  const adapter: LlmAdapter = {
    provider: 'snapshot-test',
    model: 'snapshot-model',
    async *stream(request) {
      requests.push(request)
      call += 1
      if (call === 1) {
        await lookupFiber.dispose()
        yield { toolCalls: [{ id: 'lookup-1', name: 'lookup', args: {} }] }
        return
      }
      yield { delta: 'done' }
    },
  }

  await ctx.plugin(llmProviderPlugin(adapter))
  await ctx.plugin(jsonlSessionPlugin, { path: join(dir, 'snapshot.jsonl') })
  await ctx.plugin(agentLoopPlugin, {})
  await ctx.loop.submit([{ type: 'text', text: 'look it up' }])

  const { events } = await ctx.sessionLog.read()
  const headers = events.filter(event => event.type === 'request/header')
  expect(headers[0]?.header.systemPrompt).toBe('Use registered tools.')
  expect(headers[0]?.header.tools?.map(tool => tool.name)).toEqual(['lookup'])
  expect(headers[1]?.header.tools).toBeUndefined()
  expect(events.find(event => event.type === 'tool/result')).toMatchObject({
    type: 'tool/result',
    id: 'lookup-1',
    ok: true,
    output: { text: 'snapshot result' },
  })
  expect(requests[0]?.tools?.map(tool => tool.name)).toEqual(['lookup'])
  expect(requests[1]?.tools).toBeUndefined()
})
