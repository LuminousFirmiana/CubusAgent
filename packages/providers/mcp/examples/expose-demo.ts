#!/usr/bin/env node
/**
 * 亲手看 S2.3 的"暴露与检索"（不接模型、不花钱）：
 *
 *   pnpm --filter @cubus/mcp run demo:expose
 *   pnpm --filter @cubus/mcp run demo:expose -- --tools 200
 *
 * 它打印：① 按体量选出的模式；② 两档模式下 tools[] 里会有什么、清单多大；
 * ③ 一次 tool_search（关键词与 select:）；④ 一次 mcp_call。
 */
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectMcpServers,
  decideExposureMode,
  mcpToolSchemaChars,
  mountMcpExposure,
  MCP_TOOL_CALL,
  MCP_TOOL_SEARCH,
  planMcpExposure,
} from '../src/index.ts'

const argv = process.argv.slice(2)
const argOf = (flag: string, fallback: string): string => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : fallback
}

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', 'fixtures', 'mcp-echo-server.mjs')
const toolCount = Number.parseInt(argOf('--tools', '120'), 10)
const contextWindow = Number.parseInt(argOf('--context', '200000'), 10)

const connections = await connectMcpServers([
  { name: 'demo', command: process.execPath, args: [fixture, '--tools', String(toolCount)] },
])
const mode = decideExposureMode({ tools: connections.tools, contextWindow })
const plan = planMcpExposure({ tools: connections.tools, mode })
const schemaChars = mcpToolSchemaChars(connections.tools)

const estimate = (chars: number): number => Math.floor(chars / 2.5)
const nameListChars = plan.promptText.length
process.stdout.write('远端工具 ' + String(connections.tools.length) + ' 个，schema 合计 ' + String(schemaChars) +
  ' 字符（约 ' + String(estimate(schemaChars)) + ' token）\n')
process.stdout.write('上下文窗口 ' + String(contextWindow) + '，10% 阈值 = ' + String(estimate(contextWindow * 0.1 * 2.5)) + ' token\n')
process.stdout.write('=> 选中的模式：' + mode + '\n\n')

process.stdout.write('全量模式  tools[] = 内建工具 + ' + String(connections.tools.length) + ' 个远端 schema（约 ' +
  String(estimate(schemaChars)) + ' token）\n')
process.stdout.write('按需模式  tools[] = 内建工具 + 2 个元工具；名字清单 ' + String(nameListChars) +
  ' 字符（约 ' + String(estimate(nameListChars)) + ' token），schema 取到才进上下文\n')
process.stdout.write('这一档省下的工具定义：约 ' + String(estimate(schemaChars) - estimate(nameListChars)) + ' token\n\n')

const ctx = new Context()
await ctx.plugin(systemPromptPlugin)
await ctx.plugin(toolRegistryPlugin)
await mountMcpExposure(ctx, plan, connections)
const registered = ctx.tools.snapshot()
process.stdout.write('实际注册的工具（' + String(registered.length) + ' 个）：' +
  registered.slice(0, 6).map(tool => tool.name).join(', ') +
  (registered.length > 6 ? ', …' : '') + '\n\n')

const signal = new AbortController().signal
const search = registered.find(tool => tool.name === MCP_TOOL_SEARCH)
if (search !== undefined) {
  const byKeyword = String(await search.execute({ query: 'paginated records' }, { signal }))
  process.stdout.write('tool_search "paginated records" -> ' + String(byKeyword.split('\n')[0]) + '\n')
  const selected = String(await search.execute({ query: 'select:demo__echo_tool_7' }, { signal }))
  process.stdout.write('tool_search "select:demo__echo_tool_7" -> 命中 ' +
    String(selected.includes('demo__echo_tool_7') ? 1 : 0) + ' 个，返回 ' + String(selected.length) + ' 字符\n')
}
const call = registered.find(tool => tool.name === MCP_TOOL_CALL)
if (call !== undefined) {
  process.stdout.write('mcp_call demo__echo_tool_7 -> ' +
    String(await call.execute({ tool: 'demo__echo_tool_7', arguments: { text: 'hello' } }, { signal })) + '\n')
}

await connections.close()
process.stdout.write('\n已关闭连接。\n')