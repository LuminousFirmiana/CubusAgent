import { expect, test } from 'vitest'
import type { LlmAdapter, LlmChunk, LlmRequest } from '@cubus/llm'
import {
  EXTRACT_INSTRUCTION,
  EXTRACT_SYSTEM_PROMPT,
  extractMemories,
  MemoryStore,
  parseMemoryCandidates,
  renderExtractionInput,
} from '../src/index.ts'
import type { MemoryIO } from '../src/index.ts'

function memoryIO(initial: Record<string, string> = {}) {
  const files = { ...initial }
  return {
    io: {
      async read(path: string) { return files[path] },
      async append(path: string, text: string) { files[path] = (files[path] ?? '') + text },
    } satisfies MemoryIO,
    files,
  }
}

const clock = () => new Date('2026-10-14T08:00:00.000Z')

function fakeAdapter(reply: string, options: { fail?: boolean } = {}): { adapter: LlmAdapter; requests: LlmRequest[] } {
  const requests: LlmRequest[] = []
  const adapter: LlmAdapter = {
    provider: 'fake',
    model: 'fake-model',
    async *stream(request: LlmRequest): AsyncGenerator<LlmChunk, void, void> {
      requests.push(request)
      if (options.fail === true) throw new Error('摘要服务 502')
      yield { delta: reply }
      yield { usage: { promptTokens: 800, completionTokens: 60, totalTokens: 860 } }
    },
  }
  return { adapter, requests }
}

const conversation = [
  { role: 'user', content: '订单模块默认超时改成 2500ms' },
  { role: 'assistant', content: '好，改完了' },
]

test('the extraction prompt is narrow: durable facts only, JSON out', () => {
  expect(EXTRACT_SYSTEM_PROMPT).toContain('FUTURE session')
  expect(EXTRACT_SYSTEM_PROMPT).toContain('Never record: transient task state')
  expect(EXTRACT_SYSTEM_PROMPT).toContain('JSON array only')
  expect(EXTRACT_INSTRUCTION).toContain('系统维护请求')
})

test('parse accepts a fenced JSON array and keeps text with tags', () => {
  const fence = String.fromCharCode(96).repeat(3)
  const answer = fence + 'json\n' +
    '[{"text":"订单模块默认超时 2500ms","tags":["order","决定"]},{"text":"用 vitest","tags":[]}]\n' +
    fence
  const candidates = parseMemoryCandidates(answer)
  expect(candidates).toEqual([
    { text: '订单模块默认超时 2500ms', tags: ['order', '决定'] },
    { text: '用 vitest', tags: [] },
  ])
})

test('parse falls back to one fact per line when the model ignores the format', () => {
  const candidates = parseMemoryCandidates('- 订单模块默认超时 2500ms\n1. 用 vitest 而不是 jest')
  expect(candidates.map(candidate => candidate.text)).toEqual(['订单模块默认超时 2500ms', '用 vitest 而不是 jest'])
  // 兜底路径打上模板版本标签，便于事后分辨"哪条是提炼来的"
  expect(candidates[0]?.tags).toEqual(['extract-v1'])
})

test('parse drops malformed items instead of inventing text', () => {
  expect(parseMemoryCandidates('[{"tags":["x"]},{"text":"  "},{"text":"好的"}]')).toEqual([
    { text: '好的', tags: [] },
  ])
  expect(parseMemoryCandidates('[]')).toEqual([])
  // 有 JSON 数组时以它为准（哪怕上面还有别的行）—— 解析器不猜模型想要什么
  expect(parseMemoryCandidates('- 看起来像事实\n[]')).toEqual([])
  expect(parseMemoryCandidates('   ')).toEqual([])
})

test('extraction writes new entries, reports duplicates, and returns usage', async () => {
  const { io, files } = memoryIO({
    '/mem/memory.jsonl': JSON.stringify({ id: 'm-2026-10-13-001', at: '2026-10-13T00:00:00.000Z', tags: [], text: '订单模块默认超时 2500ms' }) + '\n',
  })
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: clock })
  const { adapter, requests } = fakeAdapter('[{"text":"订单模块默认超时 2500ms"},{"text":"发布窗口固定在周四","tags":["发布"]}]')

  const report = await extractMemories(adapter, { store, messages: conversation })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.systemPrompt).toBe(EXTRACT_SYSTEM_PROMPT)
  expect(JSON.stringify(requests[0]?.messages)).toContain('订单模块默认超时改成 2500ms')
  expect(report.added.map(entry => entry.text)).toEqual(['发布窗口固定在周四'])
  expect(report.duplicates.map(entry => entry.id)).toEqual(['m-2026-10-13-001'])
  expect(report.usage?.totalTokens).toBe(860)
  expect(report.error).toBeUndefined()
  expect(files['/mem/memory.jsonl']?.split('\n').filter(Boolean)).toHaveLength(2)
})

test('a failing model call reports the error and writes nothing', async () => {
  const { io, files } = memoryIO()
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: clock })
  const { adapter } = fakeAdapter('', { fail: true })

  const report = await extractMemories(adapter, { store, messages: conversation })

  expect(report.error).toContain('502')
  expect(report.added).toEqual([])
  expect(files['/mem/memory.jsonl']).toBeUndefined()
})

test('the extraction input is capped from the front, keeping the latest turns', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(100) }, { role: 'assistant', content: '最新的结论在这里' }]
  const input = renderExtractionInput(messages, 40)
  expect(input.startsWith('（更早内容已省略）')).toBe(true)
  expect(input).toContain('最新的结论在这里')
  expect(input.length).toBeLessThan(80)
})