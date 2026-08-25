import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScriptedAdapter } from '@cubus/llm'
import type { LlmAdapter, LlmChunk, LlmRequest } from '@cubus/llm'
import { deriveRequest } from '@cubus/session'
import type { SessionEvent } from '@cubus/session'
import { SessionLogFile } from '@cubus/session-jsonl'
import type { Tool } from '@cubus/tool-registry'
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
    {
      type: 'request/header',
      stepId: 'id3',
      header: {
        provider: 'scripted',
        model: 'scripted',
        tools: [{
          name: 'echo',
          description: 'Echo back the given arguments as JSON. For testing the tool loop.',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: 'any text to echo back' } },
            required: ['text'],
          },
        }],
      },
    },
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
    'step/start', 'request/header', 'assistant/chunk', 'assistant/message',
    'tool/call', 'tool/result', 'step/end',
    'step/start', 'request/header', 'assistant/chunk', 'assistant/message', 'step/end',
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

test('cancel during tool execution settles every recorded call and stops the turn', async () => {
  const log = new SessionLogFile(logPath)
  const started = deferred()
  const executed: number[] = []
  const blockingTool: Tool = {
    name: 'blocking',
    description: 'Wait until the invocation is cancelled.',
    parameters: { type: 'object' },
    execute(args, context) {
      executed.push((args as { index: number }).index)
      started.resolve()
      return new Promise<string>((_resolve, reject) => {
        const cancel = (): void => reject(context.signal.reason)
        if (context.signal.aborted) cancel()
        else context.signal.addEventListener('abort', cancel, { once: true })
      })
    },
  }
  const adapter = new ScriptedAdapter([{ steps: [{ chunk: { toolCalls: [
    { id: 'c1', name: 'blocking', args: { index: 1 } },
    { id: 'c2', name: 'blocking', args: { index: 2 } },
  ] } }] }])
  const loop = new Loop({ log, adapter, tools: [blockingTool], generateId: makeIdGen() })

  const run = loop.submit([{ type: 'text', text: '开始' }])
  await started.promise
  loop.cancel()
  await run

  const { events } = await log.read()
  expect(executed).toEqual([1])
  expect(events.filter(event => event.type === 'tool/result')).toEqual([
    { type: 'tool/result', id: 'c1', ok: false, output: { text: 'cancelled' } },
    { type: 'tool/result', id: 'c2', ok: false, output: { text: 'cancelled before execution' } },
  ])
  expect(events.filter(event => event.type === 'step/start')).toHaveLength(1)
  expect(events.slice(-2)).toEqual([
    { type: 'step/end', stepId: 'id3' },
    { type: 'turn/end', turnId: 'id2' },
  ])
})

test('the configured systemPrompt reaches the adapter on every request', async () => {
  // 记录型适配器：捕获收到的请求，不产出任何碎片
  const received: LlmRequest[] = []
  const recorder: LlmAdapter = {
    provider: 'recording',
    model: 'recording-model',
    async *stream(request: LlmRequest): AsyncGenerator<LlmChunk, void, void> {
      received.push(request)
      yield* []
    },
  }
  const log = new SessionLogFile(join(dir, 'run-rec', 'session.jsonl'))
  await mkdir(join(dir, 'run-rec'))
  const loop = new Loop({
    log,
    adapter: recorder,
    tools: [echoTool],
    systemPrompt: '你是一个修 bug 的 agent。',
    generateId: makeIdGen(),
  })

  await loop.submit([{ type: 'text', text: '你好' }])

  expect(received).toHaveLength(1)
  expect(received[0]?.systemPrompt).toBe('你是一个修 bug 的 agent。')
  const { events } = await log.read()
  const header = events.find(event => event.type === 'request/header')
  expect(header).toMatchObject({
    stepId: 'id3',
    header: { provider: 'recording', model: 'recording-model' },
  })
  expect(received[0]).toEqual(deriveRequest(events, 'id3'))
})

test('reasoning is finalized in the log and projected into the next step request', async () => {
  const requests: LlmRequest[] = []
  const adapter: LlmAdapter = {
    provider: 'reasoning-test',
    model: 'reasoning-model',
    async *stream(request: LlmRequest): AsyncGenerator<LlmChunk, void, void> {
      requests.push(request)
      if (requests.length === 1) {
        yield { thinkingDelta: '先分析' }
        yield { toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'x' } }] }
        return
      }
      yield { delta: '完成' }
    },
  }
  const log = new SessionLogFile(join(dir, 'reasoning.jsonl'))
  const loop = new Loop({ log, adapter, tools: [echoTool], generateId: makeIdGen() })

  await loop.submit([{ type: 'text', text: '开始' }])

  const { events } = await log.read()
  expect(events.find(event => event.type === 'assistant/message')).toMatchObject({ thinking: '先分析' })
  expect(requests[1]?.messages).toContainEqual({
    role: 'assistant',
    content: [],
    thinking: '先分析',
    toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'x' } }],
  })
})

test('an unserializable request header fails before the adapter can see it', async () => {
  let calls = 0
  const adapter: LlmAdapter = {
    provider: 'never-called',
    model: 'never-called',
    async *stream(): AsyncGenerator<LlmChunk, void, void> {
      calls++
      yield { delta: '不应出现' }
    },
  }
  const log = new SessionLogFile(join(dir, 'unserializable.jsonl'))
  const loop = new Loop({
    log,
    adapter,
    tools: [{
      name: 'bad_schema',
      description: 'Contains a non-JSON schema value.',
      parameters: { invalid: 1n },
      execute: () => '',
    }],
    generateId: makeIdGen(),
  })

  await expect(loop.submit([{ type: 'text', text: '开始' }])).rejects.toThrow()
  expect(calls).toBe(0)
  const { events } = await log.read()
  expect(events.map(event => event.type)).toEqual([
    'turn/start', 'user/message', 'step/start', 'turn/end',
  ])
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
