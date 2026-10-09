import type { AgentRecipe, AgentRecipeManifest } from '@cubus/agent-recipe'
import { systemPromptContribution } from '@cubus/system-prompt'
import { requireToolApproval, withToolApproval } from '@cubus/tool-approval'
import { toolContribution } from '@cubus/tool-registry'
import { createTools } from '@cubus/tools'
import type { BudgetLimits } from '@cubus/session'

export const CODING_AGENT_PROMPT = [
  '你是一个在受信本地工作区中协助开发者完成任务的 Coding Agent。',
  '先检查相关代码和项目约束，再做范围尽可能小且完整的修改。',
  '可用工具：read_file、edit_file、write_file、bash。',
  '不要假设命令或测试成功；修改后应运行相关检查并根据实际结果继续处理。',
  '完成时简要说明改动、验证结果和仍存在的风险。',
].join('\n')

/** 本产品的工具面：声明与实现共享同一份名单（装配期校验集合相等）。 */
export const CODING_AGENT_TOOLS = ['read_file', 'edit_file', 'write_file', 'bash'] as const

/**
 * 能力需求：模型、会话事实源、工作区读写、命令执行、逐工具审批。
 *
 * sandbox 声明为**可选**：本产品不强制隔离（本地开发档），但 Host 提供的隔离信息
 * 会原样进装配快照 —— 这样"这次到底有没有隔离"永远可从日志回答。
 * 无人值守 / 陌生仓库档应当把 sandbox 声明为必需并带 features（见设计文档 §4）。
 */
export const CODING_AGENT_REQUIREMENTS = [
  { kind: 'llm', features: ['tool-calling'] },
  { kind: 'session-log' },
  { kind: 'fs', features: ['read', 'write'] },
  { kind: 'subprocess', features: ['cancellation'] },
  { kind: 'approval' },
  { kind: 'sandbox', required: false },
] as const

/** 产品默认预算（C5）：足够做完一个正常任务，又能挡住"跑飞"。app 可覆盖或收紧。 */
export const CODING_AGENT_BUDGET: BudgetLimits = {
  maxSteps: 40,
  maxToolCalls: 60,
  maxDurationMs: 600_000,
  // D3b：累计 token 上限（读 assistant/message.usage）。
  maxTokens: 200_000,
}

export interface CodingAgentRecipeDefinition {
  id: string
  version: string
  displayName: string
  description?: string
  defaultSystemPrompt: string
  /** 默认预算上限；缺省用 CODING_AGENT_BUDGET。 */
  budget?: BudgetLimits
  /** 这个产品按哪套评测计分（可选；套件 id 由评测包注册与校验）。 */
  evaluationSuite?: string
  /** 默认审批档；app 可覆盖（优先级 app > manifest）。 */
  permissionProfile?: string
}

/**
 * Build a Coding Agent product variant without copying its tool assembly.
 *
 * B4 起 provider 全部来自 Host：Recipe 只声明需求，并在 mount 时从 ctx 读
 * fs / subprocess / workspaceDir（缺失即装配失败，不会退化成运行期错误）。
 */
export function createCodingAgentRecipe(definition: CodingAgentRecipeDefinition): AgentRecipe<void> {
  const manifest: AgentRecipeManifest = {
    contractVersion: 1,
    id: definition.id,
    version: definition.version,
    displayName: definition.displayName,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    requires: CODING_AGENT_REQUIREMENTS,
    prompt: { fragmentId: definition.id + '.role' },
    tools: [...CODING_AGENT_TOOLS],
    permission: { profile: definition.permissionProfile ?? 'ask' },
    budget: definition.budget ?? CODING_AGENT_BUDGET,
    ...(definition.evaluationSuite === undefined
      ? {}
      : { evaluation: { suite: definition.evaluationSuite } }),
    presentation: { label: definition.displayName },
  }

  return {
    manifest,
    async mount(ctx) {
      const approval = requireToolApproval(ctx)
      const fs = ctx.get('fs')
      const subprocess = ctx.get('subprocess')
      const workspaceDir = ctx.get('workspaceDir')
      if (fs === undefined || subprocess === undefined || workspaceDir === undefined) {
        throw new Error(
          definition.id + ' recipe requires host-provided fs, subprocess and workspaceDir',
        )
      }
      await ctx.plugin(systemPromptContribution({
        id: manifest.prompt.fragmentId,
        text: definition.defaultSystemPrompt,
      }))
      for (const tool of createTools(fs, subprocess, workspaceDir)) {
        await ctx.plugin(toolContribution(withToolApproval(tool, approval)))
      }
    },
  }
}

export const codingAgentRecipe = createCodingAgentRecipe({
  id: 'coding-agent',
  version: '1.0.0',
  displayName: 'Coding Agent',
  description: '在受信工作区里读写代码、运行命令并验证结果的通用编码 Agent。',
  defaultSystemPrompt: CODING_AGENT_PROMPT,
})
