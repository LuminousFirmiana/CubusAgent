import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCodingAgentRecipe } from '@cubus/recipe-coding-agent'
import {
  buildMcpConfig,
  connectMcpServers,
  MCP_TOOL_CALL,
  MCP_TOOL_SEARCH,
  withMcpTools,
} from '../src/index.ts'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'mcp-echo-server.mjs')

test('the decorator widens the declaration and mounts the meta tools', async () => {
  const connections = await connectMcpServers([
    { name: 'fake', command: process.execPath, args: [fixtures, '--tools', '4'] },
  ])
  try {
    const product = createCodingAgentRecipe({
      id: 'decorated',
      version: '1.0.0',
      displayName: 'Decorated',
      defaultSystemPrompt: 'You are a coding agent.',
    })
    const decorated = withMcpTools(product, { connections, contextWindow: 200_000, configured: 'on-demand' })

    // 声明面扩了：两个元工具进 tools，mcp 进 toolSources
    expect([...decorated.manifest.tools].sort()).toEqual(
      [...product.manifest.tools, MCP_TOOL_CALL, MCP_TOOL_SEARCH].sort(),
    )
    expect(decorated.manifest.toolSources).toEqual(['mcp'])
    // 产品自己的身份不变
    expect(decorated.manifest.id).toBe('decorated')
    expect(decorated.manifest.budget).toEqual(product.manifest.budget)

    // 挂载：产品工具 + 两个元工具；按需模式下没有远端工具
    const fs = {
      async readText() { return '' },
      async writeText() {},
    }
    const subprocess = {
      async run() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false } },
    }
    const ctx = new Context()
    await ctx.plugin(systemPromptPlugin)
    await ctx.plugin(toolRegistryPlugin)
    ctx.provide('fs', fs)
    ctx.provide('subprocess', subprocess)
    ctx.provide('workspaceDir', '/workspace')
    ctx.provide('toolApproval', { profile: 'allow', decide: async () => ({ decision: 'allow' }) } as never)
    await decorated.mount(ctx, { mcp: buildMcpConfig(connections, 'on-demand') })

    const names = ctx.tools.snapshot().map(tool => tool.name).sort()
    expect(names).toEqual(['bash', 'edit_file', MCP_TOOL_CALL, MCP_TOOL_SEARCH, 'read_file', 'write_file'].sort())
    expect(ctx.systemPrompt.assemble()).toContain('fake__echo_tool_1')
  } finally {
    await connections.close()
  }
}, 20_000)

test('the snapshot config records which servers connected and which mode was used', async () => {
  const connections = await connectMcpServers([
    { name: 'ok', command: process.execPath, args: [fixtures, '--tools', '3'] },
    { name: 'bad', command: '/nonexistent/cubus-mcp-server' },
  ])
  try {
    const config = buildMcpConfig(connections, 'on-demand')
    expect(config.mode).toBe('on-demand')
    expect(config.deferredTools).toBe(3)
    expect(config.servers).toEqual([
      { name: 'ok', transport: 'stdio', connected: true, toolCount: 3 },
      expect.objectContaining({ name: 'bad', connected: false, toolCount: 0 }),
    ])
    // 快照里只有事实，没有凭据：只出现服务器名/传输/工具数
    expect(JSON.stringify(config)).not.toContain('token')
    expect(buildMcpConfig(connections, 'eager').deferredTools).toBe(0)
  } finally {
    await connections.close()
  }
}, 20_000)

test('with no MCP server configured the decorator is completely transparent', async () => {
  // 回归（S2.4）：声明无条件加两个元工具、挂载却有条件跳过 -> 装配期判 "declared but not registered"，
  // 没配 MCP 的产品连会话都建不出来。声明与实现必须同进同退。
  const empty = await connectMcpServers([])
  try {
    const product = createCodingAgentRecipe({
      id: 'no-mcp',
      version: '1.0.0',
      displayName: 'No MCP',
      defaultSystemPrompt: 'You are a coding agent.',
    })
    const decorated = withMcpTools(product, { connections: empty, contextWindow: 128_000 })

    // 声明面一模一样，toolSources 也不该凭空出现
    expect(decorated.manifest.tools).toEqual(product.manifest.tools)
    expect(decorated.manifest.toolSources).toBeUndefined()

    // 挂载后注册集合与声明集合相等（装配期校验不会报 mismatch）
    const fs = { async readText() { return '' }, async writeText() {} }
    const subprocess = { async run() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false } } }
    const ctx = new Context()
    await ctx.plugin(systemPromptPlugin)
    await ctx.plugin(toolRegistryPlugin)
    ctx.provide('fs', fs)
    ctx.provide('subprocess', subprocess)
    ctx.provide('workspaceDir', '/workspace')
    ctx.provide('toolApproval', { profile: 'allow', decide: async () => ({ decision: 'allow' }) } as never)
    await decorated.mount(ctx, {})

    expect(ctx.tools.snapshot().map(tool => tool.name).sort()).toEqual([...decorated.manifest.tools].sort())
  } finally {
    await empty.close()
  }
}, 20_000)
