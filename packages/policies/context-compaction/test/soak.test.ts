import { expect, test } from 'vitest'
import type { LlmAdapter, LlmChunk, LlmRequest } from '@cubus/llm'
import { deriveMessages } from '@cubus/session'
import type { SessionEvent, SessionLog, SessionLogListener, SessionLogReadResult } from '@cubus/session'
import { ContextCompactionPolicy } from '../src/index.ts'

class MemoryLog implements SessionLog {
  readonly events: SessionEvent[]
  constructor(events: SessionEvent[] = []) {
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

/** 只回一句短摘要的假模型（soak 关心的是"窗口有没有被撑爆"，不是摘要质量）。 */
const adapter: LlmAdapter = {
  provider: 'soak',
  model: 'soak-model',
  async *stream(_request: LlmRequest): AsyncGenerator<LlmChunk, void, void> {
    yield { delta: '（摘要）用户在多轮对话里逐步交代了需求；已完成的动作与当前状态见尾部。' }
    yield { usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 } }
  },
}

function projectedTokens(log: MemoryLog): number {
  const text = JSON.stringify(deriveMessages(log.events))
  return Math.ceil(text.length / 4)
}

/** 造一轮真实形状的对话（user + assistant，各约 500 token）。 */
async function appendTurn(log: MemoryLog, turn: number): Promise<void> {
  await log.append({ type: 'turn/start', turnId: 't' + String(turn) })
  await log.append({ type: 'step/start', stepId: 's' + String(turn), turnId: 't' + String(turn) })
  await log.append({ type: 'user/message', messageId: 'u' + String(turn), content: [{ type: 'text', text: '第 ' + String(turn) + ' 轮：' + 'x'.repeat(2_000) }] })
  await log.append({ type: 'request/header', stepId: 's' + String(turn), header: { provider: 'soak', model: 'soak-model' } })
  await log.append({ type: 'assistant/message', messageId: 'a' + String(turn), stepId: 's' + String(turn), content: [{ type: 'text', text: '收到 ' + String(turn) + '：' + 'y'.repeat(2_000) }] })
  await log.append({ type: 'step/end', stepId: 's' + String(turn) })
  await log.append({ type: 'turn/end', turnId: 't' + String(turn) })
}

test('a 200-turn session stays inside the window, compacts along the way, and loses no events', async () => {
  const log = new MemoryLog()
  const contextWindow = 8_000
  const policy = new ContextCompactionPolicy({ log, adapter, contextWindow })

  let peak = 0
  for (let turn = 0; turn < 200; turn += 1) {
    await appendTurn(log, turn)
    await policy.prepareNextRequest()
    peak = Math.max(peak, projectedTokens(log))
  }

  const compactions = log.events.filter(event => event.type === 'context/compacted').length
  // 200 轮 × 约 1k token：不压缩早就爆了；压缩把它压在窗口之内
  expect(compactions).toBeGreaterThan(10)
  expect(peak).toBeLessThanOrEqual(contextWindow)
  // 日志一条没少：压缩只改投影
  expect(log.events.filter(event => event.type === 'user/message')).toHaveLength(200)
  expect(log.events.filter(event => event.type === 'assistant/message')).toHaveLength(200)
  // 每次压缩都写在日志里，且边界单调前进（不会反复摘要同一段）
  const boundaries = log.events.filter(event => event.type === 'context/compacted').map(event => event.type === 'context/compacted' ? event.keepFrom : -1)
  expect([...boundaries].sort((left, right) => left - right)).toEqual(boundaries)
  expect(new Set(boundaries).size).toBe(boundaries.length)
}, 60_000)
