import type { AgentRecipe, AgentRecipeManifest } from '@cubus/agent-recipe'
import { systemPromptContribution } from '@cubus/system-prompt'
import { requireToolApproval, withToolApproval } from '@cubus/tool-approval'
import { toolContribution } from '@cubus/tool-registry'
import { createTools } from '@cubus/tools'
import type { FsProvider, SubprocessProvider } from '@cubus/tools'

export const CODING_AGENT_PROMPT = [
  '你是一个在受信本地工作区中协助开发者完成任务的 Coding Agent。',
  '先检查相关代码和项目约束，再做范围尽可能小且完整的修改。',
  '可用工具：read_file、edit_file、write_file、bash。',
  '不要假设命令或测试成功；修改后应运行相关检查并根据实际结果继续处理。',
  '完成时简要说明改动、验证结果和仍存在的风险。',
].join('\n')

export interface CodingAgentRecipeOptions {
  fs: FsProvider
  subprocess: SubprocessProvider
  workspaceDir: string
  systemPrompt?: string
}

export interface CodingAgentRecipeDefinition {
  manifest: AgentRecipeManifest
  defaultSystemPrompt: string
}

/** Build a Coding Agent product variant without copying its tool assembly. */
export function createCodingAgentRecipe(
  definition: CodingAgentRecipeDefinition,
): AgentRecipe<CodingAgentRecipeOptions> {
  return {
    manifest: definition.manifest,
    async mount(ctx, options) {
      const approval = requireToolApproval(ctx)
      await ctx.plugin(systemPromptContribution({
        id: `${definition.manifest.id}.role`,
        text: options.systemPrompt ?? definition.defaultSystemPrompt,
      }))
      for (const tool of createTools(options.fs, options.subprocess, options.workspaceDir)) {
        await ctx.plugin(toolContribution(withToolApproval(tool, approval)))
      }
    },
  }
}

export const codingAgentRecipe = createCodingAgentRecipe({
  manifest: {
    id: 'coding-agent',
    version: '1.0.0',
    displayName: 'Coding Agent',
  },
  defaultSystemPrompt: CODING_AGENT_PROMPT,
})
