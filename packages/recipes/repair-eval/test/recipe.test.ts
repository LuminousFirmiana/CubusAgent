import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { createStaticToolApproval } from '@cubus/tool-approval'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import type { FsProvider, SubprocessProvider } from '@cubus/tools'
import { CODING_AGENT_PROMPT, REPAIR_EVAL_SUITE, repairEvalRecipe } from '../src/index.ts'

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
  ctx.provide('fs', fs)
  ctx.provide('subprocess', subprocess)
  ctx.provide('workspaceDir', '/workspace')
  ctx.provide('toolApproval', createStaticToolApproval('allow', 'automated repair eval'))
  await repairEvalRecipe.mount(ctx)

  expect(ctx.systemPrompt.assemble()).toBe(CODING_AGENT_PROMPT)
  expect(ctx.tools.snapshot().map(tool => tool.name)).toEqual([
    'bash',
    'edit_file',
    'read_file',
    'write_file',
  ])
})

test('declares the repair-eval suite and keeps ask as the product default', () => {
  // 套件 id 是 recipe 与评测 harness 之间的契约：声明不一致 harness 直接拒绝计分。
  expect(repairEvalRecipe.manifest.evaluation).toEqual({ suite: REPAIR_EVAL_SUITE })
  expect(repairEvalRecipe.manifest.permission).toEqual({ profile: 'ask' })
  expect(repairEvalRecipe.manifest.prompt.fragmentId).toBe('repair-eval.role')
})
