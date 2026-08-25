import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { AgentRecipe } from '@cubus/agent-recipe'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import type { LlmAdapter } from '@cubus/llm'
import { toolContribution } from '@cubus/tool-registry'
import type { Tool } from '@cubus/tool-registry'
import type { JsonRpcError, JsonRpcSuccess } from '../src/protocol.ts'
import { createRunnerMethods, SessionRuntime } from '../src/runner.ts'
import { RpcServer } from '../src/server.ts'
import { createMemoryTransport } from '../src/transport.ts'

let dir: string

function makeIdGen(prefix: string) {
  let n = 0
  return () => `${prefix}${++n}`
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

type Scenes = ConstructorParameters<typeof ScriptedAdapter>[0]

const echoTool: Tool = {
  name: 'echo',
  description: 'Echo arguments as JSON.',
  parameters: { type: 'object' },
  execute: args => JSON.stringify(args),
}

const sdkTestRecipe: AgentRecipe<void> = {
  manifest: { id: 'sdk-test', version: '1.0.0', displayName: 'SDK Test Agent' },
  async mount(ctx) {
    await ctx.plugin(toolContribution(echoTool))
  },
}

async function setup(scenes: Scenes) {
  const runtime = new SessionRuntime({
    rootDir: dir,
    host: createLocalAgentHost({ adapterFactory: () => new ScriptedAdapter(scenes) }),
    recipe: sdkTestRecipe,
    recipeOptions: undefined,
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

test('session.cancel interrupts the active tool and the run returns a settled turn', async () => {
  const started = deferred()
  const adapter = new ScriptedAdapter([{ steps: [{ chunk: { toolCalls: [
    { id: 'wait-1', name: 'wait', args: {} },
  ] } }] }])
  const waitTool: Tool = {
    name: 'wait',
    description: 'Wait for cancellation.',
    parameters: { type: 'object' },
    execute(_args, context) {
      started.resolve()
      return new Promise<string>((_resolve, reject) => {
        const cancel = (): void => reject(context.signal.reason)
        if (context.signal.aborted) cancel()
        else context.signal.addEventListener('abort', cancel, { once: true })
      })
    },
  }
  const recipe: AgentRecipe<void> = {
    manifest: { id: 'cancel-test', version: '1.0.0', displayName: 'Cancel Test' },
    async mount(ctx) {
      await ctx.plugin(toolContribution(waitTool))
    },
  }
  const runtime = new SessionRuntime({
    rootDir: dir,
    host: createLocalAgentHost({ adapterFactory: () => adapter }),
    recipe,
    recipeOptions: undefined,
    generateId: makeIdGen('c'),
  })
  const transport = createMemoryTransport()
  const server = new RpcServer(transport, createRunnerMethods(runtime))
  expect(server).toBeDefined()
  const created = await rpc(transport, 'session.create') as JsonRpcSuccess
  const sessionId = (created.result as { id: string }).id

  const running = rpc(transport, 'session.run', { sessionId, text: 'wait' }, 2)
  await started.promise
  const cancelled = await rpc(transport, 'session.cancel', { sessionId }, 3) as JsonRpcSuccess
  const result = await running as JsonRpcSuccess

  expect(cancelled.result).toEqual({ sessionId })
  const turn = result.result as { turnEvents: { type: string, id?: string, ok?: boolean, output?: { text: string } }[] }
  expect(turn.turnEvents.find(event => event.type === 'tool/result')).toMatchObject({
    id: 'wait-1',
    ok: false,
    output: { text: 'cancelled' },
  })
  expect(turn.turnEvents.at(-1)?.type).toBe('turn/end')
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

test('concurrent runs on one session each wait for and return their own complete turn', async () => {
  const firstStarted = deferred()
  const releaseFirst = deferred()
  let call = 0
  const adapter: LlmAdapter = {
    provider: 'queue-test',
    model: 'queue-model',
    async *stream() {
      call++
      if (call === 1) {
        firstStarted.resolve()
        await releaseFirst.promise
        yield { delta: '第一轮' }
        return
      }
      yield { delta: '第二轮' }
    },
  }
  const runtime = new SessionRuntime({
    rootDir: dir,
    host: createLocalAgentHost({ adapterFactory: () => adapter }),
    recipe: sdkTestRecipe,
    recipeOptions: undefined,
    generateId: makeIdGen('q'),
  })
  const session = await runtime.create()

  const first = runtime.run(session.id, '一')
  await firstStarted.promise
  const second = runtime.run(session.id, '二')
  releaseFirst.resolve()

  const [firstResult, secondResult] = await Promise.all([first, second])
  expect(firstResult.assistantText).toBe('第一轮')
  expect(secondResult.assistantText).toBe('第二轮')
  expect(firstResult.turnEvents.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(secondResult.turnEvents.filter(event => event.type === 'turn/start')).toHaveLength(1)
  expect(firstResult.turnEvents.find(event => event.type === 'user/message')?.content[0]?.text).toBe('一')
  expect(secondResult.turnEvents.find(event => event.type === 'user/message')?.content[0]?.text).toBe('二')
})
