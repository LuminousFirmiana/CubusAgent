import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { asConnectionError, decodeMessage, encodeNotification, encodeRequest, LineSplitter, unwrapResult } from './jsonrpc.ts'
import { McpConnectionError } from './types.ts'
import type { McpClient, McpServerConfig, McpToolCallResult, McpToolDefinition } from './types.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const CLOSE_GRACE_MS = 1_500
const STDERR_TAIL_LINES = 20

/**
 * stdio 传输：起一个本地子进程，用一行一条 JSON-RPC 的方式通信。
 *
 * 两点与仓库既有约束有关：
 * - **不走 subprocess seam**：seam 目前是"一次执行、拿结果"的语义，而 MCP 需要**双工会话**。
 *   要沙箱覆盖 MCP 子进程，得先把 duplex 会话加进 seam —— 见 docs/design/mcp-seam.md §8。
 * - **按进程组终止**：子进程自己还会派生子进程（例如 npx 拉起的服务器），只杀直接子进程会留孤儿；
 *   因此 spawn 时 detached（自成进程组），关闭时 `kill(-pid)`，与 docker host 的取消语义一致。
 */
export class StdioMcpClient implements McpClient {
  private readonly config: McpServerConfig
  private readonly timeoutMs: number
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()
  private readonly splitter = new LineSplitter()
  private readonly stderrTail: string[] = []
  private closed = false

  constructor(config: McpServerConfig) {
    this.config = config
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 起进程并等 spawn 结果（命令不存在要立刻失败，而不是等到超时）。 */
  /** 子进程 pid（诊断用；关闭后为 undefined）。 */
  get pid(): number | undefined {
    return this.child?.pid
  }

  async start(): Promise<void> {
    const command = this.config.command
    if (command === undefined || command.trim() === '') {
      throw new McpConnectionError(this.config.name, 'stdio transport requires a command')
    }
    const child = spawn(command, [...(this.config.args ?? [])], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...this.config.env },
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      for (const line of this.splitter.push(chunk)) this.onLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim() === '') continue
        this.stderrTail.push(line.trim())
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
      }
    })
    child.on('exit', (code, signal) => {
      if (this.closed) return
      this.failAll(new McpConnectionError(
        this.config.name,
        'server exited (code ' + String(code) + (signal === null ? '' : ', signal ' + signal) + ')' + this.describeStderr(),
      ))
    })

    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError)
        resolve()
      }
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn)
        reject(new McpConnectionError(this.config.name, 'failed to start: ' + error.message))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  async initialize(): Promise<{ protocolVersion?: string; serverName?: string }> {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cubus', version: '0.1.0' },
    })
    // 握手第二阶段：通知服务端"我准备好了"，此后它才会正常响应工具调用。
    this.child?.stdin.write(encodeNotification('notifications/initialized'))
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
    if (this.closed) return
    this.closed = true
    const child = this.child
    this.child = undefined
    this.failAll(new McpConnectionError(this.config.name, 'client closed'))
    if (child === undefined) return

    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
    })
    child.stdin.end()
    this.signalGroup(child, 'SIGTERM')
    const grace = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, CLOSE_GRACE_MS)
      timer.unref?.()
    })
    await Promise.race([exited, grace])
    this.signalGroup(child, 'SIGKILL')
    await exited
  }

  private signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    const pid = child.pid
    if (pid === undefined) return
    try {
      // 负 pid = 整个进程组（spawn 时 detached 让子进程自成一组）
      process.kill(-pid, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // 已经退出了
      }
    }
  }

  private describeStderr(): string {
    return this.stderrTail.length === 0 ? '' : '; stderr: ' + this.stderrTail.join(' | ')
  }

  private onLine(line: string): void {
    const message = decodeMessage(line)
    if (message === undefined) return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    try {
      entry.resolve(unwrapResult(message))
    } catch (error) {
      entry.reject(asConnectionError(this.config.name, error))
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child
    if (child === undefined || this.closed) {
      return Promise.reject(new McpConnectionError(this.config.name, 'client is not running'))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpConnectionError(this.config.name, 'request timed out: ' + method))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(encodeRequest(id, method, params), error => {
        if (error === undefined || error === null) return
        const entry = this.pending.get(id)
        if (entry === undefined) return
        clearTimeout(entry.timer)
        this.pending.delete(id)
        reject(new McpConnectionError(this.config.name, 'write failed: ' + error.message))
      })
    })
  }
}
