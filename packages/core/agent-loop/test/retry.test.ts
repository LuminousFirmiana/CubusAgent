import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { LlmError } from '@cubus/llm'
import type { LlmAdapter } from '@cubus/llm'
import { SessionLogFile } from '@cubus/session-jsonl'
import { echoTool } from '../src/echo-tool.ts'
import { Loop } from '../src/loop.ts'

/** 循环级重试（F4b）：重试是请求事实，必须能在日志里看到。 */

let counter = 0
async function makeLog(): Promise<{ log: SessionLogFile; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'cubus-loop-retry-'))
  return {
    log: new SessionLogFile(join(dir, 'session-' + String(++counter) + '.jsonl')),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function flakyAdapter(failures: number, retryable = true): { adapter: LlmAdapter; attempts: () => number } {
  let attempts = 0
  return {
    adapter: {
      provider: 'flaky',
      model: 'flaky',
      async *stream() {
        attempts += 1
        if (attempts <= failures) {
          throw new LlmError('boom ' + String(attempts), { kind: 'network', retryable })
        }
        yield { delta: 'recovered' }
      },
    },
    attempts: () => attempts,
  }
}

test('a transient failure before any chunk is retried, and the retry lands in the log', async () => {
  const { log, cleanup } = await makeLog()
  const flaky = flakyAdapter(1)
  const loop = new Loop({
    log,
    adapter: flaky.adapter,
    tools: [echoTool],
    retry: { maxAttempts: 3, initialDelayMs: 0, sleep: async () => {} },
  })

  await loop.submit([{ type: 'text', text: '你好' }])
  const { events } = await log.read()

  const retries = events.filter(event => event.type === 'request/retry')
  expect(retries).toHaveLength(1)
  expect(retries[0]).toMatchObject({ attempt: 2, reason: 'boom 1' })
  expect(flaky.attempts()).toBe(2)
  // 重试成功：回合正常闭合，回复是第二次尝试的内容
  expect(events.at(-1)?.type).toBe('turn/end')
  const message = events.find(event => event.type === 'assistant/message')
  expect(message?.type === 'assistant/message' ? message.content : []).toEqual([{ type: 'text', text: 'recovered' }])

  await cleanup()
})

test('a non-retryable failure is not retried, and neither is a failure after the stream started', async () => {
  const first = await makeLog()
  const fatal = flakyAdapter(1, false)
  const fatalLoop = new Loop({ log: first.log, adapter: fatal.adapter, tools: [echoTool], retry: { maxAttempts: 3, sleep: async () => {} } })
  await expect(fatalLoop.submit([{ type: 'text', text: '你好' }])).rejects.toThrow('boom 1')
  expect((await first.log.read()).events.some(event => event.type === 'request/retry')).toBe(false)
  await first.cleanup()

  // 已经吐出 chunk 之后失败：不能重试（重放会重复输出）
  const second = await makeLog()
  let attempts = 0
  const midStream: LlmAdapter = {
    provider: 'mid',
    model: 'mid',
    async *stream() {
      attempts += 1
      yield { delta: '部分' }
      throw new LlmError('断流', { kind: 'network', retryable: true })
    },
  }
  const midLoop = new Loop({ log: second.log, adapter: midStream, tools: [echoTool], retry: { maxAttempts: 3, sleep: async () => {} } })
  await expect(midLoop.submit([{ type: 'text', text: '你好' }])).rejects.toThrow('断流')
  expect(attempts).toBe(1)
  expect((await second.log.read()).events.some(event => event.type === 'request/retry')).toBe(false)
  await second.cleanup()
})

test('the loop writes timestamps on turn boundaries (duration metrics need them)', async () => {
  const { log, cleanup } = await makeLog()
  let clock = 1_000
  const loop = new Loop({
    log,
    adapter: flakyAdapter(0).adapter,
    tools: [echoTool],
    now: () => {
      clock += 1_500
      return clock
    },
  })

  await loop.submit([{ type: 'text', text: '你好' }])
  const { events } = await log.read()
  const start = events.find(event => event.type === 'turn/start')
  const end = events.find(event => event.type === 'turn/end')
  expect(start?.type === 'turn/start' ? typeof start.at : undefined).toBe('string')
  expect(end?.type === 'turn/end' ? typeof end.at : undefined).toBe('string')
  // 时间戳可解析且不倒退（具体数值由注入的时钟决定）
  const startAt = Date.parse(start!.at ?? '')
  const endAt = Date.parse(end!.at ?? '')
  expect(endAt).toBeGreaterThanOrEqual(startAt)

  await cleanup()
})
