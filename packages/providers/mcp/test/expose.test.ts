import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import type { Tool } from '@cubus/tool-registry'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  connectMcpServers,
  decideExposureMode,
  McpConfigError,
  mountMcpExposure,
  MCP_TOOL_CALL,
  MCP_TOOL_SEARCH,
  mcpToolSchemaChars,
  planMcpExposure,
  qualifiedToolName,
  searchTools,
} from '../src/index.ts'
import type { McpConnections } from '../src/index.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mcp-echo-server.mjs')

/** 体量接近真实 MCP 服务器：描述较长、参数较多，单个 schema 约 1.3k 字符。 */
function fakeTool(index: number): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return {
    name: 'tool_' + String(index),
    description: 'Operate on records in the connected workspace. ' +
      'Supports filtering by owner, state, assignee and free-text query, pagination via cursor, ' +
      'and field selection so callers can request only the attributes they need. ' +
      'Returns a paginated envelope with metadata about the result set. '.repeat(4),
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Filter by owner of the target resource.' },
        state: { type: 'string', description: 'Filter by state.' },
        assignee: { type: 'string', description: 'Filter by assignee.' },
        query: { type: 'string', description: 'Free-text query.' },
        cursor: { type: 'string', description: 'Pagination cursor.' },
        limit: { type: 'integer', description: 'Maximum number of records.' },
      },
      required: ['owner'],
    },
  }
}

test('the exposure mode follows volume, and explicit configuration wins', () => {
  const small = [fakeTool(1)]
  const large = Array.from({ length: 100 }, (_, index) => fakeTool(index))

  // 体量小：全量给（省下的那点上下文不值得多两步）
  expect(decideExposureMode({ tools: small, contextWindow: 200_000 })).toBe('eager')
  // 百级工具：按需检索
  expect(decideExposureMode({ tools: large, contextWindow: 200_000 })).toBe('on-demand')
  // 没有远端工具：全量（等价于没有 MCP）
  expect(decideExposureMode({ tools: [], contextWindow: 200_000 })).toBe('eager')
  // 显式配置优先于体量
  expect(decideExposureMode({ tools: large, contextWindow: 200_000, configured: 'eager' })).toBe('eager')
  expect(decideExposureMode({ tools: small, contextWindow: 200_000, configured: 'on-demand' })).toBe('on-demand')
  // native 需要 provider 支持：不支持就报错，不静默降级
  expect(() => decideExposureMode({ tools: large, contextWindow: 200_000, configured: 'native' }))
    .toThrow(McpConfigError)
  expect(decideExposureMode({
    tools: large,
    contextWindow: 200_000,
    configured: 'native',
    providerSupportsNative: true,
  })).toBe('native')

  // 阈值口径：百级工具远大于 200k 上下文的 10%
  expect(mcpToolSchemaChars(large)).toBeGreaterThan(200_000 * 0.1 * 2.5)
})

test('the plan registers the two meta tools and lists deferred names in the prompt', () => {
  const tools = [
    { server: 'alpha', name: 'create_issue', description: 'Create an issue.', inputSchema: { type: 'object' } },
    { server: 'beta', name: 'send_message', description: 'Send a message.', inputSchema: { type: 'object' } },
  ]
  const onDemand = planMcpExposure({ tools, mode: 'on-demand' })
  expect(onDemand.registeredTools).toEqual([MCP_TOOL_CALL, MCP_TOOL_SEARCH])
  expect(onDemand.deferredTools).toEqual(['alpha__create_issue', 'beta__send_message'])
  expect(onDemand.promptText).toContain('# mcpTools')
  expect(onDemand.promptText).toContain('alpha, beta')
  expect(onDemand.promptText).toContain('- alpha__create_issue')
  // 清单里只有名字，没有 schema
  expect(onDemand.promptText).not.toContain('input_schema')

  const eager = planMcpExposure({ tools, mode: 'eager' })
  expect(eager.registeredTools).toEqual([MCP_TOOL_CALL, MCP_TOOL_SEARCH, 'alpha__create_issue', 'beta__send_message'])
  expect(eager.promptText).toBe('')
  expect(eager.deferredTools).toEqual([])
})

test('search supports keywords and select: by qualified or short name', () => {
  const tools = [
    { server: 'alpha', name: 'create_issue', description: 'Create an issue in the tracker.', inputSchema: { type: 'object' } },
    { server: 'alpha', name: 'list_issues', description: 'List issues.', inputSchema: { type: 'object' } },
    { server: 'beta', name: 'send_message', description: 'Send a chat message.', inputSchema: { type: 'object' } },
  ]
  expect(searchTools(tools, 'issue', 5).map(tool => tool.name)).toEqual(['create_issue', 'list_issues'])
  expect(searchTools(tools, 'chat message', 5).map(tool => tool.name)).toEqual(['send_message'])
  expect(searchTools(tools, 'select:alpha__create_issue,beta__send_message', 5).map(tool => tool.name))
    .toEqual(['create_issue', 'send_message'])
  expect(searchTools(tools, 'select:list_issues', 5).map(tool => tool.name)).toEqual(['list_issues'])
  expect(searchTools(tools, 'nothing-matches-this', 5)).toEqual([])
  // 结果条数上限
  expect(searchTools(tools, 'select:create_issue,list_issues,send_message', 2)).toHaveLength(2)
})

test('on-demand mounting exposes only the meta tools, and they reach the server', async () => {
  const connections = await connectMcpServers([
    { name: 'fake', command: process.execPath, args: [fixtures, '--tools', '6'] },
  ])
  try {
    const plan = planMcpExposure({ tools: connections.tools, mode: 'on-demand' })
    const ctx = new Context()
    await ctx.plugin(systemPromptPlugin)
    await ctx.plugin(toolRegistryPlugin)
    await mountMcpExposure(ctx, plan, connections)

    // 关键断言：延迟模式下 tools[] 里没有远端工具，只有两个元工具
    const snapshot = ctx.tools.snapshot()
    expect(snapshot.map(tool => tool.name)).toEqual([MCP_TOOL_CALL, MCP_TOOL_SEARCH])
    expect(snapshot.every(tool => tool.source === undefined)).toBe(true)
    // 清单进了 system prompt（模型因此知道有哪些工具可用）
    expect(ctx.systemPrompt.assemble()).toContain('fake__echo_tool_3')

    const signal = new AbortController().signal
    const search = snapshot.find(tool => tool.name === MCP_TOOL_SEARCH) as Tool
    const found = await search.execute({ query: 'select:fake__echo_tool_3' }, { signal })
    expect(String(found)).toContain('fake__echo_tool_3')
    expect(String(found)).toContain('input_schema')

    const call = snapshot.find(tool => tool.name === MCP_TOOL_CALL) as Tool
    expect(await call.execute({ tool: 'fake__echo_tool_2', arguments: { text: 'hi' } }, { signal }))
      .toBe('echo: hi')
    // 短名唯一时也认
    expect(await call.execute({ tool: 'echo_tool_1', arguments: { text: 'yo' } }, { signal }))
      .toBe('echo: yo')
    // 未知工具：报错（进 tool/result 的 ok:false 路径），信息里给可用例子
    await expect(call.execute({ tool: 'nope' }, { signal })).rejects.toThrow('unknown tool: nope')
  } finally {
    await connections.close()
  }
}, 20_000)

test('eager mounting registers the remote tools with the mcp source label', async () => {
  const connections: McpConnections = await connectMcpServers([
    { name: 'fake', command: process.execPath, args: [fixtures, '--tools', '3'] },
  ])
  try {
    const plan = planMcpExposure({ tools: connections.tools, mode: 'eager' })
    const ctx = new Context()
    await ctx.plugin(systemPromptPlugin)
    await ctx.plugin(toolRegistryPlugin)
    await mountMcpExposure(ctx, plan, connections)

    const snapshot = ctx.tools.snapshot()
    expect(snapshot.map(tool => tool.name).sort()).toEqual([
      MCP_TOOL_CALL,
      MCP_TOOL_SEARCH,
      qualifiedToolName('fake', 'echo_tool_1'),
      qualifiedToolName('fake', 'echo_tool_2'),
      qualifiedToolName('fake', 'echo_tool_3'),
    ].sort())
    expect(snapshot.filter(tool => tool.source === 'mcp')).toHaveLength(3)
    // 全量模式下远端工具可以被直接调用
    const direct = snapshot.find(tool => tool.name === qualifiedToolName('fake', 'echo_tool_1')) as Tool
    expect(await direct.execute({ text: 'direct' }, { signal: new AbortController().signal }))
      .toBe('echo: direct')
    // 全量模式不写名字清单（schema 已经在 tools[] 里）
    expect(ctx.systemPrompt.assemble()).toBeUndefined()
  } finally {
    await connections.close()
  }
}, 20_000)