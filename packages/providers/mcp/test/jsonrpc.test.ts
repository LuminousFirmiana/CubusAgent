import { expect, test } from 'vitest'
import {
  decodeMessage,
  encodeNotification,
  encodeRequest,
  LineSplitter,
  McpProtocolError,
  unwrapResult,
} from '../src/index.ts'

test('requests and notifications are one JSON-RPC line each', () => {
  expect(encodeRequest(7, 'tools/list', {})).toBe('{"jsonrpc":"2.0","id":7,"method":"tools/list","params":{}}\n')
  expect(encodeRequest(1, 'initialize')).toBe('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
  expect(encodeNotification('notifications/initialized')).toBe('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
})

test('decoding keeps results, surfaces errors and ignores everything else', () => {
  expect(decodeMessage('{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}')).toEqual({ id: 3, result: { tools: [] } })
  expect(decodeMessage('{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"nope"}}'))
    .toEqual({ id: 3, error: { code: -32601, message: 'nope' } })
  // 通知（无 id）、畸形 JSON、非 2.0：都忽略，不让连接崩掉
  expect(decodeMessage('{"jsonrpc":"2.0","method":"notifications/message"}')).toBeUndefined()
  expect(decodeMessage('not json')).toBeUndefined()
  expect(decodeMessage('{"id":1,"result":{}}')).toBeUndefined()
})

test('unwrapResult throws a typed protocol error carrying the code', () => {
  expect(unwrapResult({ id: 1, result: { ok: true } })).toEqual({ ok: true })
  let caught: unknown
  try {
    unwrapResult({ id: 1, error: { code: -32602, message: 'bad params', data: { tool: 'x' } } })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(McpProtocolError)
  expect((caught as McpProtocolError).code).toBe(-32602)
  expect((caught as McpProtocolError).message).toBe('bad params')
})

test('the line splitter reassembles messages across arbitrary chunk boundaries', () => {
  const splitter = new LineSplitter()
  expect(splitter.push('{"a":1}\n{"b":')).toEqual(['{"a":1}'])
  expect(splitter.push('2}\n\n  \n')).toEqual(['{"b":2}'])
  expect(splitter.push('{"partial":')).toEqual([])
  expect(splitter.flush()).toBe('{"partial":')
  expect(splitter.push('')).toEqual([])
})
