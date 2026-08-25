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

export const referenceAgentRecipe: AgentRecipe<void> = {
  manifest: {
    id: 'reference-agent',
    version: '1.0.0',
    displayName: 'Reference Agent',
  },
  async mount(ctx) {
    await ctx.plugin(systemPromptContribution({
      id: 'reference-agent.role',
      text: REFERENCE_AGENT_PROMPT,
    }))
    await ctx.plugin(toolContribution(addNumbersTool))
  },
}
