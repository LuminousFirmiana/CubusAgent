import { expect, test } from 'vitest'
import { createMemoryTransport } from '../src/transport.ts'
import { RpcServer } from '../src/server.ts'
import type { JsonRpcSuccess, JsonRpcError } from '../src/protocol.ts'

function makeServer(methods: Record<string, (params: Record<string, unknown>) => unknown | Promise<unknown>>) {
  const transport = createMemoryTransport()
  const server = new RpcServer(transport, methods)
  return { transport, server }
}

function lastResponse(transport: ReturnType<typeof createMemoryTransport>) {
  const last = transport.responses.at(-1)
  expect(last).toBeDefined()
  return JSON.parse(last!) as JsonRpcSuccess | JsonRpcError
}

test('valid request returns result with the same id', async () => {
  const { transport } = makeServer({
    echo: params => params['text'],
  })

  transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'echo', params: { text: '你好' } }))
  // handleLine 是异步的，等微任务队列清空
  await new Promise(r => setTimeout(r, 0))

  expect(lastResponse(transport)).toEqual({ jsonrpc: '2.0', id: 7, result: '你好' })
})

test('unknown method returns -32601 with the request id', async () => {
  const { transport } = makeServer({})
  transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'nope' }))
  await new Promise(r => setTimeout(r, 0))

  const response = lastResponse(transport) as JsonRpcError
  expect(response.error.code).toBe(-32601)
  expect(response.id).toBe(3)
})

test('a throwing method returns -32603 with its message', async () => {
  const { transport } = makeServer({
    boom: () => {
      throw new Error('内部炸了')
    },
  })
  transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'boom' }))
  await new Promise(r => setTimeout(r, 0))

  const response = lastResponse(transport) as JsonRpcError
  expect(response.error.code).toBe(-32603)
  expect(response.error.message).toBe('内部炸了')
})

test('async methods are awaited before responding', async () => {
  const { transport } = makeServer({
    slow: async params => {
      await new Promise(r => setTimeout(r, 5))
      return 'done'
    },
  })
  transport.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'slow' }))
  await new Promise(r => setTimeout(r, 20))

  expect(lastResponse(transport)).toEqual({ jsonrpc: '2.0', id: 2, result: 'done' })
})

test('malformed json returns -32700 parse error', async () => {
  const { transport } = makeServer({})
  transport.receive('这不是 json{')
  await new Promise(r => setTimeout(r, 0))

  const response = lastResponse(transport) as JsonRpcError
  expect(response.error.code).toBe(-32700)
  expect(response.id).toBeNull()
})

test('missing jsonrpc or method returns -32600 invalid request', async () => {
  const { transport } = makeServer({})
  transport.receive(JSON.stringify({ id: 1, method: 'echo' }))
  await new Promise(r => setTimeout(r, 0))

  const response = lastResponse(transport) as JsonRpcError
  expect(response.error.code).toBe(-32600)
})

