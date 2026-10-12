import { McpConnectionError } from './types.ts'

/**
 * JSON-RPC 2.0 的最小实现：只做我们要的两件事 —— 编码请求、按 id 配对响应。
 * 纯函数 + 一个行缓冲，便于单测（stdio 的一行一条消息就是这个格式）。
 */

export class McpProtocolError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'McpProtocolError'
    this.code = code
    this.data = data
  }
}

export interface DecodedMessage {
  readonly id: number
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown }
}

/** 请求编码（stdio 行协议：一条消息一行）。 */
export function encodeRequest(id: number, method: string, params?: unknown): string {
  const message: Record<string, unknown> = { jsonrpc: '2.0', id, method }
  if (params !== undefined) message.params = params
  return JSON.stringify(message) + '\n'
}

/** 通知编码（无 id，服务端不应回复）。 */
export function encodeNotification(method: string, params?: unknown): string {
  const message: Record<string, unknown> = { jsonrpc: '2.0', method }
  if (params !== undefined) message.params = params
  return JSON.stringify(message) + '\n'
}

/**
 * 解析一行消息。不是响应（通知、畸形 JSON、缺 id）时返回 undefined —— 调用方忽略即可，
 * 因为"不认识的推送"不该让连接崩掉。
 */
export function decodeMessage(line: string): DecodedMessage | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const message = parsed as Record<string, unknown>
  if (message.jsonrpc !== '2.0') return undefined
  const id = message.id
  if (typeof id !== 'number') return undefined
  const error = message.error
  if (typeof error === 'object' && error !== null) {
    const detail = error as Record<string, unknown>
    return {
      id,
      error: {
        code: typeof detail.code === 'number' ? detail.code : -32000,
        message: typeof detail.message === 'string' ? detail.message : 'unknown error',
        ...(detail.data === undefined ? {} : { data: detail.data }),
      },
    }
  }
  return { id, result: message.result }
}

/** 把响应拆成"结果"或抛出协议错误（调用方负责补上服务器名）。 */
export function unwrapResult(message: DecodedMessage): unknown {
  if (message.error === undefined) return message.result
  throw new McpProtocolError(message.error.code, message.error.message, message.error.data)
}

/** 增量行缓冲：把任意切片拼回完整行（stdio 的 data 事件不保证按行到达）。 */
export class LineSplitter {
  private buffer = ''

  push(chunk: string): string[] {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    return lines.map(line => line.trim()).filter(line => line !== '')
  }

  /** 连接关闭时残留的半行：丢弃并返回，便于诊断。 */
  flush(): string {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest
  }
}

/** 把协议错误包装成带服务器名的连接错误（保持错误信息可定位）。 */
export function asConnectionError(serverName: string, error: unknown): McpConnectionError {
  if (error instanceof McpConnectionError) return error
  if (error instanceof McpProtocolError) {
    return new McpConnectionError(serverName, 'protocol error ' + String(error.code) + ': ' + error.message)
  }
  return new McpConnectionError(serverName, error instanceof Error ? error.message : String(error))
}
