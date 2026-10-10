import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { createStaticToolApproval } from '@cubus/tool-approval'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import type { FsProvider, SubprocessProvider } from '@cubus/tools'
import {
  CUBUS_CODING_AGENT_ID,
  CUBUS_CODING_AGENT_PROMPT,
  CUBUS_CODING_AGENT_VERSION,
  cubusCodingAgentRecipe,
} from '../src/index.ts'

test('装配快照里的产品身份：id、版本与显示名都是产品自己的', () => {
  expect(cubusCodingAgentRecipe.manifest.id).toBe(CUBUS_CODING_AGENT_ID)
  expect(cubusCodingAgentRecipe.manifest.version).toBe(CUBUS_CODING_AGENT_VERSION)
  expect(cubusCodingAgentRecipe.manifest.displayName).toBe('Cubus CodingAgent')
  expect(cubusCodingAgentRecipe.manifest.presentation).toEqual({ label: 'Cubus CodingAgent' })
})

test('产品提示词是产品自己的那一份，不是通用 coding-agent 提示词', () => {
  expect(CUBUS_CODING_AGENT_PROMPT).toContain('Cubus CodingAgent')
  expect(cubusCodingAgentRecipe.manifest.prompt.fragmentId).toBe(CUBUS_CODING_AGENT_ID + '.role')
})

test('工具面由产品声明，装配后与声明一致（四工具）', async () => {
  const mount = await mountProduct()
  expect([...cubusCodingAgentRecipe.manifest.tools].sort()).toEqual([
    'bash',
    'edit_file',
    'read_file',
    'write_file',
  ])
  expect(mount.toolNames).toEqual([...cubusCodingAgentRecipe.manifest.tools].sort())
  expect(mount.prompt).toBe(CUBUS_CODING_AGENT_PROMPT)
})

test('Host 缺少产品声明的能力时装配失败，而不是退化成运行期错误', async () => {
  // 缺审批：第一条就拒绝（不问模型、不执行工具）。
  const bare = new Context()
  await bare.plugin(systemPromptPlugin)
  await bare.plugin(toolRegistryPlugin)
  await expect(cubusCodingAgentRecipe.mount(bare)).rejects.toThrow(/tool approval/)

  // 有审批但缺 fs/subprocess/workspaceDir：仍然拒绝，且指明缺的是哪几项。
  const noWorkspace = new Context()
  await noWorkspace.plugin(systemPromptPlugin)
  await noWorkspace.plugin(toolRegistryPlugin)
  noWorkspace.provide('toolApproval', createStaticToolApproval('allow', 'product recipe test'))
  await expect(cubusCodingAgentRecipe.mount(noWorkspace)).rejects.toThrow(
    /fs, subprocess and workspaceDir/,
  )
})

test('默认审批档是 ask（无人值守档由 app 显式覆盖并进快照）', () => {
  expect(cubusCodingAgentRecipe.manifest.permission).toEqual({ profile: 'ask' })
})

async function mountProduct(): Promise<{ prompt: string; toolNames: string[] }> {
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
  ctx.provide('toolApproval', createStaticToolApproval('allow', 'product recipe test'))
  await cubusCodingAgentRecipe.mount(ctx)
  return {
    prompt: ctx.systemPrompt.assemble() ?? '',
    toolNames: ctx.tools.snapshot().map(tool => tool.name).sort(),
  }
}
