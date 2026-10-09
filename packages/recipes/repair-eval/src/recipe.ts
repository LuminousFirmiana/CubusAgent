import { CODING_AGENT_PROMPT, createCodingAgentRecipe } from '@cubus/recipe-coding-agent'

// 评测 harness 与用例从这里取提示词，保持"同一份提示词"的单一来源。
export { CODING_AGENT_PROMPT }

/** 修复评测套件 id：recipe 的 evaluation.suite 与评测 harness 共享它。 */
export const REPAIR_EVAL_SUITE = 'repair-eval-v1'

/**
 * 修复评测产品：与 coding-agent 同一套工具面，但按修复任务计分。
 * 默认审批档保持 'ask'；评测 harness 作为 app 覆盖为 'allow'（快照记录 source: app）。
 */
export const repairEvalRecipe = createCodingAgentRecipe({
  id: 'repair-eval',
  version: '1.0.0',
  displayName: 'Repair Eval Agent',
  description: '按隐藏测试计分的 Coding Agent 变体，用于修复任务评测。',
  defaultSystemPrompt: CODING_AGENT_PROMPT,
  evaluationSuite: REPAIR_EVAL_SUITE,
})
