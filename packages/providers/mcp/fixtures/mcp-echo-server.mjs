#!/usr/bin/env node
/**
 * 一个最小的 MCP stdio 服务器（零依赖），供集成测试与工作台演示共用。
 *
 * 支持的方法：initialize、notifications/initialized、tools/list、tools/call。
 * 参数：
 *   --tools <n>    暴露多少个工具（默认 8），名字形如 echo_tool_1
 *   --props <n>    每个工具多少条参数（默认 6）—— 用来模拟真实服务器的 schema 体量
 *   --fail         启动即退出（用于测"连不上不阻塞装配"）
 *   --name <name>  serverInfo.name（默认 fake-mcp）
 *
 * 体量刻意做得接近真实 MCP 服务器（描述 3–4 句 + 多参数带描述，单个 schema 约 1.3k 字符）：
 * 只有这样才能验证"百级工具会挤占上下文"这个前提，也才能让工具定义体量的测量有意义。
 *
 * 只用于测试：不实现 MCP 的 prompts/resources/sampling，也不做鉴权。
 */
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
if (argv.includes('--fail')) process.exit(1)

const toolCount = Number.parseInt(argOf('--tools', '8'), 10)
const propCount = Number.parseInt(argOf('--props', '6'), 10)
const serverName = argOf('--name', 'fake-mcp')

const FIELDS = ['owner', 'state', 'assignee', 'query', 'cursor', 'limit', 'sort', 'fields', 'since', 'until']

const properties = {}
for (let index = 0; index < propCount; index += 1) {
  const field = FIELDS[index % FIELDS.length]
  properties[field] = {
    type: field === 'limit' ? 'integer' : 'string',
    description: 'Filter results by the ' + field + ' of the target resource. ' +
      (index % 2 === 0 ? 'Optional; omit to include every value.' : 'Applies to the active workspace only.'),
  }
}
properties.options = {
  type: 'object',
  description: 'Provider specific options: dry_run to validate without writing, include_archived, response_format.',
  properties: {
    dry_run: { type: 'boolean', description: 'Validate the request without applying it.' },
    include_archived: { type: 'boolean', description: 'Include archived records in the result set.' },
    response_format: { type: 'string', enum: ['json', 'markdown'], description: 'Preferred response format.' },
  },
}

const tools = Array.from({ length: toolCount }, (_, index) => ({
  name: 'echo_tool_' + String(index + 1),
  description:
    'Retrieve and operate on records in the connected workspace (tool ' + String(index + 1) + ' of ' + String(toolCount) + '). ' +
    'Supports filtering by owner, state, assignee and free-text query, pagination via cursor, and field selection ' +
    'so callers can request only the attributes they need. Returns a paginated envelope with metadata about the ' +
    'result set, including a cursor for the next page when more records are available.',
  inputSchema: { type: 'object', properties, required: ['owner'] },
}))

const send = message => process.stdout.write(JSON.stringify(message) + '\n')

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  // 通知没有 id，不回响应。
  if (message.id === undefined) return
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result })
  const fail = (code, text) => send({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })

  switch (message.method) {
    case 'initialize':
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '1.0.0' },
      })
      return
    case 'tools/list':
      reply({ tools })
      return
    case 'tools/call': {
      const name = message.params?.name
      if (!tools.some(tool => tool.name === name)) {
        fail(-32602, 'unknown tool: ' + String(name))
        return
      }
      reply({ content: [{ type: 'text', text: 'echo: ' + String(message.params?.arguments?.text ?? '') }] })
      return
    }
    default:
      fail(-32601, 'method not found: ' + String(message.method))
  }
})
