import type { JsonRpcMessage, JsonRpcRequest } from './protocol.ts'

/**
 * 传输抽象：一行一个 JSON。
 * 实现：stdio（S2.1c）、内存（测试）、将来的 WebSocket。
 */
export interface RpcTransport {
  /** 服务端写出一行（一个 JSON-RPC 消息）。 */
  write(line: string): void
  /** 注册收到一行请求的回调；返回取消注册函数。 */
  onRequest(handler: (line: string) => void): () => void
}

/** 内存传输：测试与嵌入式场景用。 */
export function createMemoryTransport() {
  let handler: ((line: string) => void) | undefined
  return {
    requests: [] as string[],
    responses: [] as string[],
    write(line: string) {
      this.responses.push(line)
    },
    onRequest(h: (line: string) => void) {
      handler = h
      return () => {
        handler = undefined
      }
    },
    /** 测试辅助：模拟客户端发来一行请求。 */
    receive(line: string) {
      handler?.(line)
    },
  }
}

/** 解析并校验一行请求；非法输入返回错误响应（由调用方写出）。 */
export function parseRequestLine(line: string): { request: JsonRpcRequest } | { error: JsonRpcMessage } {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { error: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } } }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { error: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } } }
  }
  const request = parsed as Record<string, unknown>
  if (request['jsonrpc'] !== '2.0' || typeof request['method'] !== 'string' || (typeof request['id'] !== 'number' && typeof request['id'] !== 'string')) {
    return { error: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } } }
  }
  return { request: parsed as JsonRpcRequest }
}

