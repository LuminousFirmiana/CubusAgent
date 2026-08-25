import { createCodingAgentRecipe } from '@cubus/recipe-coding-agent'
import type { CodingAgentRecipeOptions } from '@cubus/recipe-coding-agent'

export const CODING_AGENT_PROMPT = [
  '你是一个修 bug 的编码 agent。',
  '可用工具：read_file（读文件）、edit_file（字符串替换编辑）、write_file（整写）、bash（跑命令）。',
  '任务：找到测试失败的原因，修改代码修复，然后用 bash 跑测试确认全部通过。',
  'edit_file 要求 old_string 在文件中唯一出现；失败时带着更多上下文重试。',
  '完成后用一句话报告你改了什么。',
].join('\n')

export type RepairEvalRecipeOptions = CodingAgentRecipeOptions

export const repairEvalRecipe = createCodingAgentRecipe({
  manifest: {
    id: 'repair-eval',
    version: '1.0.0',
    displayName: 'Repair Eval Agent',
  },
  defaultSystemPrompt: CODING_AGENT_PROMPT,
})
