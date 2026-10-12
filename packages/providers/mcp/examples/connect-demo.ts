#!/usr/bin/env node
/**
 * 亲手跑一遍 MCP 连接层（不接模型、不花钱）：
 *
 *   pnpm --filter @cubus/mcp run demo
 *   pnpm --filter @cubus/mcp run demo -- --tools 120     # 造 120 个工具
 *
 * 它做三件事：起本地假 MCP 服务器 -> 列工具 -> 调一个工具并把结果打出来。
 * 工具如何进模型上下文（延迟加载、检索）是 S2.3 的事；这一步只证明"连得上、看得见、调得动"。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectMcpServers } from '../src/index.ts'

const argv = process.argv.slice(2)
const argOf = (flag: string, fallback: string): string => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : fallback
}

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', 'fixtures', 'mcp-echo-server.mjs')
const toolCount = argOf('--tools', '60')

const started = Date.now()
const connections = await connectMcpServers([
  { name: 'local-demo', command: process.execPath, args: [fixture, '--tools', toolCount, '--name', 'demo-mcp'] },
  { name: 'broken-demo', command: '/nonexistent/cubus-mcp-server' },
])

process.stdout.write('连接结果（耗时 ' + String(Date.now() - started) + 'ms）\n')
for (const connection of connections.connections) {
  const status = connection.connected ? '✓ 已连接' : '✗ 失败'
  process.stdout.write(
    '  ' + status + '  ' + connection.name + ' (' + connection.transport + ')' +
    (connection.connected
      ? '  服务端 ' + String(connection.serverName) + '  协议 ' + String(connection.protocolVersion) +
        '  工具 ' + String(connection.tools.length) + ' 个'
      : '  原因 ' + String(connection.error)) + '\n',
  )
}

const totalChars = connections.tools.reduce(
  (sum, tool) => sum + JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }).length,
  0,
)
process.stdout.write('\n工具定义体量：' + String(connections.tools.length) + ' 个工具 / ' + String(totalChars) + ' 字符' +
  '（约 ' + String(Math.floor(totalChars / 2.5)) + ' token，按 chars/2.5 估算）\n')
process.stdout.write('前 3 个工具：' + connections.tools.slice(0, 3).map(tool => tool.name).join(', ') + '\n')

const client = connections.clients.get('local-demo')
if (client !== undefined) {
  const result = await client.callTool('echo_tool_1', { text: 'hello from cubus' })
  process.stdout.write('调用 echo_tool_1 -> ' + result.text + '（isError=' + String(result.isError) + '）\n')
}

await connections.close()
process.stdout.write('\n已关闭连接（stdio 子进程按进程组终止，不留孤儿）。\n')
