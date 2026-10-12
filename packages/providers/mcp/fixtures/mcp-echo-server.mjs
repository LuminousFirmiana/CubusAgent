#!/usr/bin/env node
/**
 * 一个最小的 MCP stdio 服务器（零依赖），供集成测试与工作台演示共用。
 *
 * 支持的方法：initialize、notifications/initialized、tools/list、tools/call。
 * 参数：
 *   --tools <n>    暴露多少个工具（默认 8），名字形如 echo_tool_1
 *   --fail         启动即退出（用于测"连不上不阻塞装配"）
 *   --name <name>  serverInfo.name（默认 fake-mcp）
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
const serverName = argOf('--name', 'fake-mcp')

const tools = Array.from({ length: toolCount }, (_, index) => ({
  name: 'echo_tool_' + String(index + 1),
  description: 'Echo back the provided text (tool ' + String(index + 1) + ' of ' + String(toolCount) + ').',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to echo back.' } },
    required: ['text'],
  },
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
