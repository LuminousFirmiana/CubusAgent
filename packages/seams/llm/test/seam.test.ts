import { expect, test } from 'vitest'
import { LlmError } from '../src/errors.ts'
import { ScriptedAdapter } from '../src/scripted.ts'
import type { LlmRequest } from '../src/types.ts'

/**
 * 接缝自己的契约测试（P1 搬迁后补上）：
 * provider 的测试跟着 provider 走了（@cubus/llm-deepseek），这里钉住接缝提供的两样东西 ——
 * 错误分类（策略据此决定要不要重试）与脚本化假模型（所有无 key 测试都靠它）。
 */

const request: LlmRequest = { provider: 'test', model: 'test', messages: [] }

test('LlmError carries the provider-neutral classification policies rely on', () => {
  const cause = new TypeError('underlying')
  const error = new LlmError('boom', { kind: 'rate-limit', retryable: true, status: 429, cause })

  expect(error).toBeInstanceOf(Error)
  expect(error.name).toBe('LlmError')
  expect(error.message).toBe('boom')
  expect(error.kind).toBe('rate-limit')
  expect(error.retryable).toBe(true)
  expect(error.status).toBe(429)
  // cause 透传：排查链不能断
  expect(error.cause).toBe(cause)

  // 没有 status 时值为 undefined（类字段声明后属性存在，但 JSON 会省略它）
  const withoutStatus = new LlmError('auth failed', { kind: 'authentication', retryable: false })
  expect(withoutStatus.status).toBeUndefined()
  expect(JSON.stringify(withoutStatus)).not.toContain('status')
  expect(withoutStatus.retryable).toBe(false)
})

async function collect(adapter: ScriptedAdapter, signal = new AbortController().signal): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of adapter.stream(request, signal)) chunks.push(chunk)
  return chunks
}

test('the scripted adapter replays scenes in order and stops quietly when the script runs out', async () => {
  const adapter = new ScriptedAdapter([
    { steps: [{ chunk: { delta: '一' } }, { chunk: { delta: '二' } }] },
    { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'x' } }] } }] },
  ])

  expect(await collect(adapter)).toEqual([{ delta: '一' }, { delta: '二' }])
  expect(await collect(adapter)).toEqual([{ toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'x' } }] }])
  // 脚本用尽：空回复，不抛错（否则重试策略会把它当成故障）
  expect(await collect(adapter)).toEqual([])
  expect(adapter.delivered).toBe(3)
})

test('a held scripted step loses the race to cancellation', async () => {
  const controller = new AbortController()
  const adapter = new ScriptedAdapter([
    { steps: [{ chunk: { delta: '开始' } }, { hold: new Promise<void>(() => {}) }] },
  ])

  const consumption = collect(adapter, controller.signal)
  controller.abort()
  await expect(consumption).rejects.toThrow('aborted')
})
