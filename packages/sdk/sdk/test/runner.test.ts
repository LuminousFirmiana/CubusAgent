import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ScriptedAdapter } from '@cubus/llm'
import type { JsonRpcError, JsonRpcSuccess } from '../src/protocol.ts'
import { createRunnerMethods, SessionRuntime } from '../src/runner.ts'
import { RpcServer } from '../src/server.ts'
import { createMemoryTransport } from '../src/transport.ts'

let dir: string

function makeIdGen(prefix: string) {
  let n = 0
  return () => `${prefix}${++n}`
}

type Scenes = ConstructorParameters<typeof ScriptedAdapter>[0]

async function setup(scenes: Scenes) {
  const runtime = new SessionRuntime({
    rootDir: dir,
    adapterFactory: () => new ScriptedAdapter(scenes),
    generateId: makeIdGen('s'),
  })
  const transport = createMemoryTransport()
  const server = new RpcServer(transport, createRunnerMethods(runtime))
  return { runtime, transport, server }
}

/**
 * 通过协议发一次请求，按 id 关联拿到响应。
 * 不猜延迟、不读"最后一条"：轮询等到匹配该 id 的响应为止（10 秒上限）。
 * 教训：固定 setTimeout 等待在慢机器（CI）上会竞态读到上一条响应。
 */
async function rpc(transport: ReturnType<typeof createMemoryTransport>, method: string, params: Record<string, unknown> = {}, id: number | string = 1) {
  const startIndex = transport.responses.length
  transport.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    for (let i = startIndex; i < transport.responses.length; i++) {
      const message = JSON.parse(transport.responses[i]!) as { id?: number | string }
      if (message.id === id) return message as JsonRpcSuccess | JsonRpcError
    }
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('rpc timeout waiting for id ' + String(id))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-sdk-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('create -> run -> assistant text over the wire', async () => {
  const { transport } = await setup([{ steps: [{ chunk: { delta: '协议版你好' } }] }])

  const created = await rpc(transport, 'session.create') as JsonRpcSuccess
  const sessionId = (created.result as { id: string }).id
  expect(sessionId).toBe('s1')

  const run = await rpc(transport, 'session.run', { sessionId, text: '你好' }, 2) as JsonRpcSuccess
  const result = run.result as { assistantText?: string; turnEvents: unknown[] }
  expect(result.assistantText).toBe('协议版你好')

  const types = result.turnEvents.map(e => (e as { type: string }).type)
  expect(types[0]).toBe('turn/start')
  expect(types.at(-1)).toBe('turn/end')
  expect(types).toContain('assistant/message')
})

test('a tool loop runs end to end through the protocol', async () => {
  const { transport } = await setup([
    { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'echo', args: { x: 42 } }] } }] },
    { steps: [{ chunk: { delta: '工具用完了' } }] },
  ])

  const created = await rpc(transport, 'session.create') as JsonRpcSuccess
  const sessionId = (created.result as { id: string }).id
  const run = await rpc(transport, 'session.run', { sessionId, text: '调工具' }) as JsonRpcSuccess
  const result = run.result as { assistantText?: string; turnEvents: { type: string }[] }

  expect(result.assistantText).toBe('工具用完了')
  const types = result.turnEvents.map(e => e.type)
  expect(types).toContain('tool/call')
  expect(types).toContain('tool/result')
  // 工具闭环 = 两个 step
  expect(types.filter(t => t === 'step/start')).toHaveLength(2)
})

test('session.list returns created sessions; unknown session errors', async () => {
  const { transport } = await setup([{ steps: [{ chunk: { delta: 'x' } }] }])

  await rpc(transport, 'session.create', {}, 1)
  await rpc(transport, 'session.create', {}, 2)
  const list = await rpc(transport, 'session.list', {}, 3) as JsonRpcSuccess
  expect(list.result).toEqual([
    { id: 's1', logPath: join(dir, 's1', 'session.jsonl') },
    { id: 's2', logPath: join(dir, 's2', 'session.jsonl') },
  ])

  const missing = await rpc(transport, 'session.run', { sessionId: 'nope', text: 'x' }, 4) as JsonRpcError
  expect(missing.error.code).toBe(-32603)
  expect(missing.error.message).toContain('session not found')
})

test('invalid params on the wire return -32602', async () => {
  const { transport } = await setup([{ steps: [{ chunk: { delta: 'x' } }] }])

  const bad = await rpc(transport, 'session.run', { sessionId: 123 }, 9) as JsonRpcError
  expect(bad.error.code).toBe(-32602)
})

test('two sessions are isolated: each has its own log and model state', async () => {
  const { transport } = await setup([{ steps: [{ chunk: { delta: '一次' } }] }])

  const a = await rpc(transport, 'session.create', {}, 1) as JsonRpcSuccess
  const b = await rpc(transport, 'session.create', {}, 2) as JsonRpcSuccess
  const idA = (a.result as { id: string }).id
  const idB = (b.result as { id: string }).id

  const runA = await rpc(transport, 'session.run', { sessionId: idA, text: 'x' }, 3) as JsonRpcSuccess
  const runB = await rpc(transport, 'session.run', { sessionId: idB, text: 'x' }, 4) as JsonRpcSuccess
  expect((runA.result as { assistantText?: string }).assistantText).toBe('一次')
  expect((runB.result as { assistantText?: string }).assistantText).toBe('一次')
})

