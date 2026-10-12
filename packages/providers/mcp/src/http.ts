import { asConnectionError, decodeMessage, unwrapResult } from './jsonrpc.ts'
import { McpConnectionError } from './types.ts'
import type { McpClient, McpServerConfig, McpToolCallResult, McpToolDefinition } from './types.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const SESSION_HEADER = 'mcp-session-id'

/**
 * Streamable HTTP 传输：每个请求一次 POST，响应可能是 `application/json`（单条）
 * 或 `text/event-stream`（若干 SSE 帧，取 id 匹配的那条）。会话 id 由服务端在
 * 响应头 `mcp-session-id` 给出，后续请求带回 —— 这是协议要求，不实现会导致
 * 有状态服务器把每次请求当新会话。
 */
export class HttpMcpClient implements McpClient {
  private readonly config: McpServerConfig
  private readonly timeoutMs: number
  private nextId = 1
  private sessionId: string | undefined
  private closed = false

  constructor(config: McpServerConfig) {
    this.config = config
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async initialize(): Promise<{ protocolVersion?: string; serverName?: string }> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cubus', version: '0.1.0' },
    })
    await this.notify('notifications/initialized')
    const detail = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
    const serverInfo = (typeof detail.serverInfo === 'object' && detail.serverInfo !== null
      ? detail.serverInfo
      : {}) as Record<string, unknown>
    return {
      ...(typeof detail.protocolVersion === 'string' ? { protocolVersion: detail.protocolVersion } : {}),
      ...(typeof serverInfo.name === 'string' ? { serverName: serverInfo.name } : {}),
    }
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    const result = await this.request('tools/list', {})
    const tools = (typeof result === 'object' && result !== null ? (result as Record<string, unknown>).tools : undefined)
    if (!Array.isArray(tools)) return []
    return tools.flatMap(entry => {
      if (typeof entry !== 'object' || entry === null) return []
      const tool = entry as Record<string, unknown>
      if (typeof tool.name !== 'string' || tool.name.trim() === '') return []
      return [{
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: (typeof tool.inputSchema === 'object' && tool.inputSchema !== null
          ? tool.inputSchema
          : { type: 'object' }) as Record<string, unknown>,
      }]
    })
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.request('tools/call', { name, arguments: args })
    const detail = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
    const content = Array.isArray(detail.content) ? detail.content : []
    const text = content
      .flatMap(block => {
        if (typeof block !== 'object' || block === null) return []
        const item = block as Record<string, unknown>
        return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
      })
      .join('\n')
    return { text, isError: detail.isError === true }
  }

  async close(): Promise<void> {
    // 无长连接可回收：会话由服务端按超时清理。保留 closed 以拒绝后续请求。
    this.closed = true
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.sessionId === undefined ? {} : { [SESSION_HEADER]: this.sessionId }),
      ...this.config.headers,
    }
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: '2.0', method })
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new McpConnectionError(this.config.name, 'client is closed')
    const id = this.nextId
    this.nextId += 1
    const body = params === undefined
      ? { jsonrpc: '2.0', id, method }
      : { jsonrpc: '2.0', id, method, params }
    const response = await this.post(body)
    if (response === undefined) {
      throw new McpConnectionError(this.config.name, 'no response for ' + method)
    }
    try {
      return unwrapResult(response)
    } catch (error) {
      throw asConnectionError(this.config.name, error)
    }
  }

  /** 发一次 POST，返回 id 匹配的响应（SSE 流里可能带着别的帧）。 */
  private async post(body: Record<string, unknown>): Promise<ReturnType<typeof decodeMessage> | undefined> {
    const url = this.config.url
    if (url === undefined || url.trim() === '') {
      throw new McpConnectionError(this.config.name, 'http transport requires a url')
    }
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new McpConnectionError(this.config.name, 'request failed: ' + (error as Error).message)
    }
    const sessionId = response.headers.get(SESSION_HEADER)
    if (sessionId !== null && sessionId !== '') this.sessionId = sessionId

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new McpConnectionError(
        this.config.name,
        'http ' + String(response.status) + (detail === '' ? '' : ': ' + detail.slice(0, 200)),
      )
    }
    // 通知（无 id）服务端可能回 202 且空体
    if (body.id === undefined) return undefined

    const contentType = response.headers.get('content-type') ?? ''
    const payload = await response.text()
    if (contentType.includes('text/event-stream')) {
      const expected = body.id as number
      for (const line of payload.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const message = decodeMessage(trimmed.slice(5).trim())
        if (message !== undefined && message.id === expected) return message
      }
      const first = payload.split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('data:'))
        .map(line => decodeMessage(line.slice(5).trim()))
        .find(message => message !== undefined)
      return first
    }
    return decodeMessage(payload.trim())
  }
}
