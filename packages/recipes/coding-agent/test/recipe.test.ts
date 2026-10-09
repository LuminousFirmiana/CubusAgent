import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { createStaticToolApproval } from '@cubus/tool-approval'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import type { FsProvider, SubprocessProvider } from '@cubus/tools'
import { CODING_AGENT_PROMPT, CODING_AGENT_REQUIREMENTS, CODING_AGENT_TOOLS, codingAgentRecipe } from '../src/index.ts'

/** 测试里的"Host 环境"：B4 起 recipe 从 ctx 读 provider，而不是从参数拿。 */
function provideEnvironment(ctx: Context): void {
  const fs: FsProvider = {
    async readText() { return '' },
    async writeText() {},
  }
  const subprocess: SubprocessProvider = {
    async run() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false } },
  }
  ctx.provide('fs', fs)
  ctx.provide('subprocess', subprocess)
  ctx.provide('workspaceDir', '/workspace')
}

test('contributes the product prompt and trusted-workspace tool surface', async () => {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolRegistryPlugin)
  provideEnvironment(ctx)
  ctx.provide('toolApproval', createStaticToolApproval('allow'))
  await codingAgentRecipe.mount(ctx)

  expect(codingAgentRecipe.manifest.id).toBe('coding-agent')
  expect(ctx.systemPrompt.assemble()).toBe(CODING_AGENT_PROMPT)
  expect(ctx.tools.snapshot().map(tool => tool.name)).toEqual([
    'bash',
    'edit_file',
    'read_file',
    'write_file',
  ])
})

test('the declared product surface matches what the recipe registers', async () => {
  // 声明与实现必须对得上：这份断言就是 verifyDeclarations 在装配期做的事。
  expect(codingAgentRecipe.manifest.prompt.fragmentId).toBe('coding-agent.role')
  expect([...codingAgentRecipe.manifest.tools].sort()).toEqual([...CODING_AGENT_TOOLS].sort())
  expect(codingAgentRecipe.manifest.requires).toEqual(CODING_AGENT_REQUIREMENTS)
  expect(codingAgentRecipe.manifest.permission).toEqual({ profile: 'ask' })
  expect(codingAgentRecipe.manifest.evaluation).toBeUndefined()
})

test('refuses to mount without a Host-provided approval policy', async () => {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolRegistryPlugin)
  provideEnvironment(ctx)

  await expect(codingAgentRecipe.mount(ctx)).rejects.toThrow(
    'Coding Agent requires a tool approval provider',
  )
  expect(ctx.systemPrompt.assemble()).toBeUndefined()
  expect(ctx.tools.snapshot()).toEqual([])
})

test('refuses to mount when the Host did not provide the environment capabilities', async () => {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolRegistryPlugin)
  ctx.provide('toolApproval', createStaticToolApproval('allow'))

  await expect(codingAgentRecipe.mount(ctx)).rejects.toThrow(
    'coding-agent recipe requires host-provided fs, subprocess and workspaceDir',
  )
})
