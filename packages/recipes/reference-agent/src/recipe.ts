import type { AgentRecipe } from '@cubus/agent-recipe'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import type { Tool } from '@cubus/tool-registry'

export const REFERENCE_AGENT_PROMPT = [
  'You are a concise, domain-neutral assistant.',
  'Use the available deterministic tools when they help answer the request.',
  'Report the result directly without inventing unavailable capabilities.',
].join('\n')

function numberField(args: unknown, name: string): number {
  if (typeof args !== 'object' || args === null || !(name in args)) {
    throw new Error(`missing argument: ${name}`)
  }
  const value = (args as Record<string, unknown>)[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`argument ${name} must be a finite number`)
  }
  return value
}

export const addNumbersTool: Tool = {
  name: 'add_numbers',
  description: 'Add two finite numbers and return the result.',
  parameters: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'first addend' },
      b: { type: 'number', description: 'second addend' },
    },
    required: ['a', 'b'],
  },
  execute(args) {
    return String(numberField(args, 'a') + numberField(args, 'b'))
  },
}

/**
 * 领域无关的最小产品：只声明模型与会话事实源，不碰文件系统、Shell 或仓库。
 * 它没有副作用工具，因此审批档为 allow（也不需要 approval 能力）。
 */
export const referenceAgentRecipe: AgentRecipe<void> = {
  manifest: {
    contractVersion: 1,
    id: 'reference-agent',
    version: '1.0.0',
    displayName: 'Reference Agent',
    description: '领域无关的最小产品：验证模型/工具闭环。',
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      // 可选：只把 Host 的隔离信息记录进快照，不强制任何隔离档。
      { kind: 'sandbox', required: false },
    ],
    prompt: { fragmentId: 'reference-agent.role' },
    tools: ['add_numbers'],
    permission: { profile: 'allow' },
    presentation: { label: 'Reference Agent' },
  },
  async mount(ctx) {
    await ctx.plugin(systemPromptContribution({
      id: 'reference-agent.role',
      text: REFERENCE_AGENT_PROMPT,
    }))
    await ctx.plugin(toolContribution(addNumbersTool))
  },
}
