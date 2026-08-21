import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScriptedAdapter } from '@cubus/llm'
import { SessionLogFile } from '@cubus/session'
import type { SessionEvent } from '@cubus/session'
import { echoTool } from '../src/echo-tool.ts'
import { Loop } from '../src/loop.ts'

let dir: string
let logPath: string

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

/** 确定性 ID 生成器：每次从 id1 开始数。 */
function makeIdGen() {
  let n = 0
  return () => `id${++n}`
}

let runCounter = 0

// 每次 runWith 使用独立子目录：保证每次跑都从空日志开始。
async function runWith(scenes: ConstructorParameters<typeof ScriptedAdapter>[0]): Promise<{ events: SessionEvent[]; log: SessionLogFile; adapter: ScriptedAdapter }> {
  const sub = join(dir, 'run-' + String(++runCounter))
  await mkdir(sub)
  const log = new SessionLogFile(join(sub, 'session.jsonl'))
  const adapter = new ScriptedAdapter(scenes)
  const loop = new Loop({ log, adapter, tools: [echoTool], generateId: makeIdGen() })
  await loop.submit([{ type: 'text', text: '你好' }])
  const { events } = await log.read()
  return { events, log, adapter }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-loop-'))
  logPath = join(dir, 'session.jsonl')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('deterministic replay: the same script produces a byte-identical log', async () => {
  const scenes = [
    { steps: [{ chunk: { delta: '你好' } }] },
  ]
  const first = await runWith(scenes)
  const second = await runWith(scenes)

  expect(second.events).toEqual(first.events)
  expect(second.events.length).toBeGreaterThan(0)
})

test('structure: events follow the turn/step vocabulary with correct id links', async () => {
  const { events } = await runWith([{ steps: [{ chunk: { delta: '你好' } }] }])

  expect(events).toEqual([
    { type: 'turn/start', turnId: 'id2' },
    { type: 'user/message', messageId: 'id1', content: [{ type: 'text', text: '你好' }] },
    { type: 'step/start', stepId: 'id3', turnId: 'id2' },
    { type: 'assistant/chunk', stepId: 'id3', delta: '你好' },
    { type: 'assistant/message', messageId: 'id4', stepId: 'id3', content: [{ type: 'text', text: '你好' }] },
    { type: 'step/end', stepId: 'id3' },
    { type: 'turn/end', turnId: 'id2' },
  ])
})

test('tool loop: call -> execute -> result feeds the next step -> final answer', async () => {
  const scenes = [
    { steps: [
      { chunk: { delta: '要调工具' } },
      { chunk: { toolCalls: [{ id: 'c1', name: 'echo', args: { x: 1 } }] } },
    ] },
    { steps: [{ chunk: { delta: '完成' } }] },
  ]
  const { events } = await runWith(scenes)

  const types = events.map(e => e.type)
  expect(types).toEqual([
    'turn/start', 'user/message',
    'step/start', 'assistant/chunk', 'assistant/message',
    'tool/call', 'tool/result', 'step/end',
    'step/start', 'assistant/chunk', 'assistant/message', 'step/end',
    'turn/end',
  ])

  const toolResult = events.find(e => e.type === 'tool/result')
  expect(toolResult).toMatchObject({ ok: true, output: { text: '{"x":1}' } })
})

test('cancel mid-stream: interrupted prefix logged, undispatched tool calls absent', async () => {
  const log = new SessionLogFile(logPath)
  const gate = deferred()
  const adapter = new ScriptedAdapter([
    { steps: [
      { chunk: { delta: '前半句' }, hold: gate.promise },
      { chunk: { delta: '后半句' } },
      { chunk: { toolCalls: [{ id: 'c1', name: 'echo', args: {} }] } },
    ] },
  ])
  const loop = new Loop({ log, adapter, tools: [echoTool], generateId: makeIdGen() })

  const run = loop.submit([{ type: 'text', text: '开始' }])
  // 等第一个碎片已产出（流确实开始了），然后取消
  await vi.waitFor(() => expect(adapter.delivered).toBe(1))
  loop.cancel()
  await run

  const { events } = await log.read()
  expect(events.map(e => e.type)).not.toContain('tool/call')
  const interrupted = events.find(e => e.type === 'assistant/message')
  expect(interrupted).toMatchObject({
    content: [{ type: 'text', text: '前半句' }],
    interrupted: true,
  })
  // 回合正常闭环
  expect(events.at(-1)).toEqual({ type: 'turn/end', turnId: 'id2' })
})

test('unknown tool produces an ok: false result, and the loop continues', async () => {
  const scenes = [
    { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'nonexistent', args: {} }] } }] },
    { steps: [{ chunk: { delta: '继续' } }] },
  ]
  const { events } = await runWith(scenes)

  const result = events.find(e => e.type === 'tool/result')
  expect(result).toMatchObject({ ok: false, output: { text: 'unknown tool: nonexistent' } })
  // 第二步仍然发生
  expect(events.filter(e => e.type === 'step/start')).toHaveLength(2)
})

