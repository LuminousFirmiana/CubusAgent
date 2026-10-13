import { expect, test } from 'vitest'
import type { LlmAdapter, LlmChunk, LlmRequest } from '@cubus/llm'
import { deriveMessages } from '@cubus/session'
import type { SessionEvent, SessionLog, SessionLogListener, SessionLogReadResult } from '@cubus/session'
import { COMPACTION_SYSTEM_PROMPT, ContextCompactionPolicy, renderMessages } from '../src/index.ts'

class MemoryLog implements SessionLog {
  readonly events: SessionEvent[]
  constructor(events: SessionEvent[]) {
    this.events = events
  }
  async append(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
  async read(): Promise<SessionLogReadResult> {
    return { events: [...this.events], truncated: false }
  }
  subscribe(_listener: SessionLogListener): () => void {
    return () => undefined
  }
}

/** 可控的假模型：正常时回固定摘要，要求时报错或回空。 */
function fakeAdapter(options: { fail?: boolean; empty?: boolean; chunks?: number } = {}): { adapter: LlmAdapter; calls: LlmRequest[] } {
  const calls: LlmRequest[] = []
  const adapter: LlmAdapter = {
    provider: 'fake',
    model: 'fake-model',
    async *stream(request: LlmRequest): AsyncGenerator<LlmChunk, void, void> {
      calls.push(request)
      if (options.fail === true) throw new Error('模型炸了')
      const text = options.empty === true ? '' : '（摘要）用户要修 add bug；已改 src/add.ts；测试通过。'
      const pieces = options.chunks ?? 1
      for (let index = 0; index < pieces; index += 1) {
        yield { delta: pieces === 1 ? text : text.slice(Math.floor((text.length * index) / pieces), Math.floor((text.length * (index + 1)) / pieces)) }
      }
      yield { usage: { promptTokens: 500, completionTokens: 40, totalTokens: 540 } }
    },
  }
  return { adapter, calls }
}

/** 造一段"很长"的对话：每条 user/assistant 约 4k 字符 → 约 1k token。 */
function longConversation(turns: number): SessionEvent[] {
  const events: SessionEvent[] = [{ type: 'session/mount', mount: undefined } as unknown as SessionEvent]
  events.pop()
  for (let index = 0; index < turns; index += 1) {
    events.push({ type: 'turn/start', turnId: 't' + String(index) })
    events.push({ type: 'step/start', stepId: 's' + String(index), turnId: 't' + String(index) })
    events.push({ type: 'user/message', messageId: 'u' + String(index), content: [{ type: 'text', text: '第' + String(index) + '轮：' + 'x'.repeat(4_000) }] })
    events.push({ type: 'request/header', stepId: 's' + String(index), header: { provider: 'fake', model: 'fake-model' } })
    events.push({ type: 'assistant/message', messageId: 'a' + String(index), stepId: 's' + String(index), content: [{ type: 'text', text: '收到' + 'y'.repeat(4_000) }] })
    events.push({ type: 'step/end', stepId: 's' + String(index) })
    events.push({ type: 'turn/end', turnId: 't' + String(index) })
  }
  return events
}

test('below the threshold nothing happens: no model call, no event', async () => {
  const log = new MemoryLog(longConversation(2))
  const { adapter, calls } = fakeAdapter()
  const policy = new ContextCompactionPolicy({ log, adapter, contextWindow: 1_000_000 })

  await policy.prepareNextRequest()

  expect(calls).toHaveLength(0)
  expect(log.events.some(event => event.type === 'context/compacted')).toBe(false)
  expect(policy.lastOutcome?.reason).toBe('below-threshold')
})

test('over the threshold it summarizes the prefix and records a compaction event', async () => {
  const log = new MemoryLog(longConversation(12))
  const { adapter, calls } = fakeAdapter({ chunks: 3 })
  const policy = new ContextCompactionPolicy({
    log,
    adapter,
    contextWindow: 6_000,
    keepRecentTokens: 2_000,
    maxKeepTokens: 3_000,
    minKeepMessages: 2,
  })

  await policy.prepareNextRequest()

  expect(calls).toHaveLength(1)
  // 摘要请求带上了模板系统提示，输入是"待压缩区间的投影"
  expect(calls[0]?.systemPrompt).toContain('compress an agent session')
  const input = JSON.stringify(calls[0]?.messages)
  expect(input).toContain('assistant:')
  // 待压缩区间本身就很大时，输入被夹到上限（为了压缩而超窗是荒谬的），且两头都保
  expect(input).toContain('（中间内容已省略）')
  expect(input).toContain('第0轮')
  expect(input.length).toBeLessThan(20_000)
  // 流式分片会被拼起来
  const event = log.events.find(candidate => candidate.type === 'context/compacted')
  expect(event?.type === 'context/compacted' ? event.summary : '').toContain('摘要')
  if (event?.type !== 'context/compacted') throw new Error('expected a compaction event')
  expect(event.input.template).toBe('compact-v1')
  expect(event.usage).toEqual({ promptTokens: 500, completionTokens: 40, totalTokens: 540 })
  expect(event.after).toBeLessThan(event.before)
  // 边界落在配对上、且投影确实变成"摘要 + 尾部"
  const projected = deriveMessages(log.events)
  expect(projected[0]).toEqual({ role: 'user', content: [{ type: 'text', text: event.summary }] })
  expect(projected.length).toBeLessThan(deriveMessages(log.events.slice(0, event.keepFrom)).length + 1 + 12)
  expect(policy.lastOutcome?.reason).toBe('summarized')
})

test('a second call never summarizes again: no extra model call, no second event', async () => {
  const log = new MemoryLog(longConversation(12))
  const { adapter, calls } = fakeAdapter()
  const policy = new ContextCompactionPolicy({
    log, adapter, contextWindow: 6_000, keepRecentTokens: 2_000, maxKeepTokens: 3_000, minKeepMessages: 2,
  })

  await policy.prepareNextRequest()
  const eventsAfterFirst = log.events.length
  await policy.prepareNextRequest()

  expect(calls).toHaveLength(1) // 第二次没有再调模型
  expect(log.events.length).toBe(eventsAfterFirst)
  expect(log.events.filter(event => event.type === 'context/compacted')).toHaveLength(1)
  // 压缩后投影已经低于阈值（或边界无法前移）——两者都属于"没有活要干"
  expect(['below-threshold', 'no-progress']).toContain(policy.lastOutcome?.reason)
})

test('failures are bounded: retries, then a circuit breaker after three consecutive failures', async () => {
  const log = new MemoryLog(longConversation(12))
  const { adapter, calls } = fakeAdapter({ fail: true })
  const policy = new ContextCompactionPolicy({
    log, adapter, contextWindow: 6_000, keepRecentTokens: 2_000, maxKeepTokens: 3_000, minKeepMessages: 2,
  })

  await policy.prepareNextRequest()
  expect(calls).toHaveLength(3) // 一次 + 两次重试
  expect(log.events.some(event => event.type === 'context/compacted')).toBe(false)
  expect(policy.consecutiveFailures).toBe(1)
  expect(policy.lastOutcome?.reason).toBe('failed')

  await policy.prepareNextRequest()
  await policy.prepareNextRequest()
  expect(policy.consecutiveFailures).toBe(3)
  const callsBefore = calls.length
  await policy.prepareNextRequest()
  expect(calls.length).toBe(callsBefore) // 熔断：不再调用模型
  expect(policy.lastOutcome?.reason).toBe('circuit-open')
})

test('an empty summary counts as a failure instead of writing a useless event', async () => {
  const log = new MemoryLog(longConversation(12))
  const { adapter } = fakeAdapter({ empty: true })
  const policy = new ContextCompactionPolicy({
    log, adapter, contextWindow: 6_000, keepRecentTokens: 2_000, maxKeepTokens: 3_000, minKeepMessages: 2,
  })

  await policy.prepareNextRequest()

  expect(log.events.some(event => event.type === 'context/compacted')).toBe(false)
  expect(policy.lastOutcome?.reason).toBe('failed')
  expect(policy.lastOutcome?.message).toContain('空摘要')
})

test('the keep budget is derived from the window: a small window cannot keep a huge tail', async () => {
  const log = new MemoryLog(longConversation(12))
  const { adapter } = fakeAdapter()
  // 窗口 3k：即使默认值是 8k/24k，保留区也必须收紧，否则"压缩后"仍然超窗
  const policy = new ContextCompactionPolicy({ log, adapter, contextWindow: 3_000 })

  await policy.prepareNextRequest()

  const event = log.events.find(candidate => candidate.type === 'context/compacted')
  if (event?.type !== 'context/compacted') throw new Error('expected a compaction event')
  expect(event.after).toBeLessThanOrEqual(3_000)
  expect(event.keepFrom).toBeGreaterThan(0)
})

test('the summarization prompt forbids tool-call markup leaking into the summary', () => {
  expect(COMPACTION_SYSTEM_PROMPT).toContain('never emit tool-call markup')
})

test('a huge tool result cannot dominate the summarization input', () => {
  const messages = [
    { role: 'user' as const, content: [{ type: 'text' as const, text: '读一个巨大的文件' }] },
    { role: 'tool-result' as const, toolCallId: 'c1', ok: true, content: 'x'.repeat(200_000) },
    { role: 'tool-result' as const, toolCallId: 'c2', ok: false, content: 'y'.repeat(50_000) },
  ]
  const rendered = renderMessages(messages)
  // 用户请求完整保留；工具结果只剩预览（全文在日志里，可读回）
  expect(rendered).toContain('读一个巨大的文件')
  expect(rendered).toContain('共 200000 字符，已省略')
  expect(rendered.length).toBeLessThan(2_000)
})
