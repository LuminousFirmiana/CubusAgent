import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { createStaticToolApproval } from '@cubus/tool-approval'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import type { FsProvider, SubprocessProvider } from '@cubus/tools'
import { CODING_AGENT_PROMPT, codingAgentRecipe } from '../src/index.ts'

test('contributes the product prompt and trusted-workspace tool surface', async () => {
  const fs: FsProvider = {
    async readText() { return '' },
    async writeText() {},
  }
  const subprocess: SubprocessProvider = {
    async run() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false } },
  }
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolRegistryPlugin)
  ctx.provide('toolApproval', createStaticToolApproval('allow'))
  await codingAgentRecipe.mount(ctx, { fs, subprocess, workspaceDir: '/workspace' })

  expect(codingAgentRecipe.manifest.id).toBe('coding-agent')
  expect(ctx.systemPrompt.assemble()).toBe(CODING_AGENT_PROMPT)
  expect(ctx.tools.snapshot().map(tool => tool.name)).toEqual([
    'bash',
    'edit_file',
    'read_file',
    'write_file',
  ])
})

test('refuses to mount without a Host-provided approval policy', async () => {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolRegistryPlugin)
  const fs: FsProvider = {
    async readText() { return '' },
    async writeText() {},
  }
  const subprocess: SubprocessProvider = {
    async run() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false } },
  }

  await expect(codingAgentRecipe.mount(ctx, { fs, subprocess, workspaceDir: '/workspace' })).rejects.toThrow(
    'Coding Agent requires a tool approval provider',
  )
  expect(ctx.systemPrompt.assemble()).toBeUndefined()
  expect(ctx.tools.snapshot()).toEqual([])
})
