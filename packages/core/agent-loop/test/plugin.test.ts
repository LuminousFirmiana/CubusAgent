import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { ScriptedAdapter } from '@cubus/llm'
import type { LlmAdapter } from '@cubus/llm'
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
  await ctx.plugin(agentLoopPlugin, { logPath: join(dir, 'a.jsonl') })

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
  const loopFiber = ctx.plugin(agentLoopPlugin, { logPath: join(dir, 'b.jsonl') })
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
  const loopFiber = ctx.plugin(agentLoopPlugin, { logPath: join(dir, 'c.jsonl') })
  await loopFiber
  expect(ctx.get('loop')).toBeDefined()
  expect(ctx.get('sessionLog')).toBeDefined()

  await loopFiber.dispose()

  expect(ctx.get('loop')).toBeUndefined()
  expect(ctx.get('sessionLog')).toBeUndefined()
})

