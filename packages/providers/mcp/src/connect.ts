import { HttpMcpClient } from './http.ts'
import { StdioMcpClient } from './stdio.ts'
import { McpConfigError, McpConnectionError } from './types.ts'
import type { McpClient, McpConnection, McpServerConfig, McpToolDefinition } from './types.ts'

/** 带来源信息的工具定义：`server` 是配置里的服务器名（不是模型可见的工具名）。 */
export interface McpToolWithServer extends McpToolDefinition {
  readonly server: string
}

export interface McpConnections {
  /** 连接成功的客户端，按服务器名索引（失败的不在里面）。 */
  readonly clients: ReadonlyMap<string, McpClient>
  /** 每台服务器的结果，**包含失败项**（失败带 error，供装配快照/告警使用）。 */
  readonly connections: readonly McpConnection[]
  /** 所有成功发现的工具，带服务器名。 */
  readonly tools: readonly McpToolWithServer[]
  close(): Promise<void>
}

function asStringArray(value: unknown, where: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new McpConfigError(where + ' must be an array of strings')
  }
  return value as readonly string[]
}

function asStringRecord(value: unknown, where: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new McpConfigError(where + ' must be an object of strings')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [key, item] of entries) {
    if (typeof item !== 'string') throw new McpConfigError(where + '.' + key + ' must be a string')
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/**
 * 解析 MCP 服务器配置（通常来自 `~/.cubus/config.json` 的 `mcpServers`）。
 * 这里**严格失败**：配置写错了应当在装配前就报出来，而不是连到一半才发现。
 */
export function parseMcpServerConfigs(value: unknown): readonly McpServerConfig[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new McpConfigError('mcpServers must be an array')
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const where = 'mcpServers[' + String(index) + ']'
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new McpConfigError(where + ' must be an object')
    }
    const raw = entry as Record<string, unknown>
    const name = raw.name
    if (typeof name !== 'string' || name.trim() === '') throw new McpConfigError(where + '.name must be a non-empty string')
    if (seen.has(name)) throw new McpConfigError('duplicate server name: ' + name)
    seen.add(name)

    const command = typeof raw.command === 'string' ? raw.command : undefined
    const url = typeof raw.url === 'string' ? raw.url : undefined
    const declared = raw.transport
    if (declared !== undefined && declared !== 'stdio' && declared !== 'http') {
      throw new McpConfigError(where + '.transport must be "stdio" or "http"')
    }
    const transport = declared ?? (url === undefined ? 'stdio' : 'http')
    if (transport === 'stdio' && (command === undefined || command.trim() === '')) {
      throw new McpConfigError(where + ' uses stdio but has no command')
    }
    if (transport === 'http' && (url === undefined || url.trim() === '')) {
      throw new McpConfigError(where + ' uses http but has no url')
    }
    const timeoutMs = raw.timeoutMs
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new McpConfigError(where + '.timeoutMs must be a positive integer')
    }
    const env = asStringRecord(raw.env, where + '.env')
    const headers = asStringRecord(raw.headers, where + '.headers')
    return {
      name,
      transport,
      ...(command === undefined ? {} : { command }),
      ...(raw.args === undefined ? {} : { args: asStringArray(raw.args, where + '.args') }),
      ...(env === undefined ? {} : { env }),
      ...(url === undefined ? {} : { url }),
      ...(headers === undefined ? {} : { headers }),
      ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
    }
  })
}

/**
 * 连接所有配置的 MCP 服务器。
 *
 * **失败不阻塞**：一台连不上只记进它自己的 `error`（连同已连接的那些一起返回），
 * 由调用方决定"告警 + 继续"还是"按产品要求拒绝装配"。工具发现失败同样只影响这一台。
 */
export async function connectMcpServers(
  configs: readonly McpServerConfig[],
): Promise<McpConnections> {
  const clients = new Map<string, McpClient>()
  const connections: McpConnection[] = []
  const tools: McpToolWithServer[] = []

  for (const config of configs) {
    const transport = config.transport ?? (config.url === undefined ? 'stdio' : 'http')
    const client: McpClient = transport === 'http' ? new HttpMcpClient(config) : new StdioMcpClient(config)
    try {
      if (client instanceof StdioMcpClient) await client.start()
      const handshake = await client.initialize()
      const discovered = await client.listTools()
      clients.set(config.name, client)
      connections.push({
        name: config.name,
        transport,
        connected: true,
        tools: discovered,
        ...(handshake.protocolVersion === undefined ? {} : { protocolVersion: handshake.protocolVersion }),
        ...(handshake.serverName === undefined ? {} : { serverName: handshake.serverName }),
      })
      for (const tool of discovered) tools.push({ ...tool, server: config.name })
    } catch (error) {
      const failure = error instanceof McpConnectionError
        ? error
        : new McpConnectionError(config.name, error instanceof Error ? error.message : String(error))
      connections.push({ name: config.name, transport, connected: false, tools: [], error: failure.message })
      await client.close().catch(() => undefined)
    }
  }

  return {
    clients,
    connections,
    tools,
    async close(): Promise<void> {
      await Promise.all([...clients.values()].map(client => client.close().catch(() => undefined)))
      clients.clear()
    },
  }
}
