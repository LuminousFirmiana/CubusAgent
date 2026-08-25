import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { createStaticToolApproval } from '@cubus/tool-approval'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import type { FsProvider, SubprocessProvider } from '@cubus/tools'
import { CODING_AGENT_PROMPT, repairEvalRecipe } from '../src/index.ts'

test('contributes the coding prompt and exactly the four repair tools', async () => {
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
  ctx.provide('toolApproval', createStaticToolApproval('allow', 'automated repair eval'))
  await repairEvalRecipe.mount(ctx, { fs, subprocess, workspaceDir: '/workspace' })

  expect(ctx.systemPrompt.assemble()).toBe(CODING_AGENT_PROMPT)
  expect(ctx.tools.snapshot().map(tool => tool.name)).toEqual([
    'bash',
    'edit_file',
    'read_file',
    'write_file',
  ])
})
