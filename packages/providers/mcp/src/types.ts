/**
 * MCP（Model Context Protocol）工具来源：配置、客户端契约与连接结果。
 *
 * 定位见 docs/design/mcp-seam.md：MCP 是**工具来源**，不是能力类型；这里只做
 * "连上、发现工具、调用工具"三件事，工具如何进上下文由产品与工具注册表决定。
 */

/** 一台 MCP 服务器的配置（app 提供；不含任何模型可见内容）。 */
export interface McpServerConfig {
  readonly name: string
  /**
   * 传输方式：`stdio` 起本地子进程，`http` 连 Streamable HTTP 端点。
   * 省略时按"有 url 走 http、有 command 走 stdio"推断。
   */
  readonly transport?: 'stdio' | 'http'
  /** stdio：可执行文件、参数与附加环境变量。 */
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  /** http：端点与请求头（凭据以 header 传入，只走 app/凭据接缝，不进日志）。 */
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  /** 单次请求超时（毫秒）；默认 30s。 */
  readonly timeoutMs?: number
}

/** 远端工具定义（MCP `tools/list` 的子集）。 */
export interface McpToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
}

/** 一次工具调用的结果（MCP `tools/call`）：文本 + 是否由远端标记为错误。 */
export interface McpToolCallResult {
  readonly text: string
  readonly isError: boolean
}

/** 连接后的最小客户端契约。 */
export interface McpClient {
  /** 握手；返回服务端版本信息（用于审计，不进模型上下文）。 */
  initialize(): Promise<{ protocolVersion?: string; serverName?: string }>
  listTools(): Promise<readonly McpToolDefinition[]>
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>
  /** 关闭并回收（stdio 按进程组终止，不留孤儿）。 */
  close(): Promise<void>
}

/** 一台服务器的连接结果：成功带 tools，失败带 error（**不抛异常**，见 connect.ts）。 */
export interface McpConnection {
  readonly name: string
  readonly transport: 'stdio' | 'http'
  readonly connected: boolean
  readonly tools: readonly McpToolDefinition[]
  readonly protocolVersion?: string
  readonly serverName?: string
  readonly error?: string
}

/** 连接失败/协议错误：消息里带上服务器名，便于装配期排查。 */
export class McpConnectionError extends Error {
  readonly serverName: string
  constructor(serverName: string, message: string) {
    super('mcp[' + serverName + ']: ' + message)
    this.name = 'McpConnectionError'
    this.serverName = serverName
  }
}

/** 配置本身有误（区别于"服务器连不上"）：装配前就应当失败。 */
export class McpConfigError extends Error {
  constructor(message: string) {
    super('mcp config: ' + message)
    this.name = 'McpConfigError'
  }
}
