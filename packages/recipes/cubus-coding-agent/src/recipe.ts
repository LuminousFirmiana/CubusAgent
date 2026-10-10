import { createCodingAgentRecipe } from '@cubus/recipe-coding-agent'

/**
 * CubusCodingAgent：运行在 CubusRuntime 之上的编码 Agent 产品（S1 产品身份）。
 *
 * 这里**只声明产品**：提示词、工具面、审批档、预算、评测套件。装配机制、能力协商与
 * 工具实现都来自运行时（@cubus/recipe-coding-agent 的工厂 + Host 提供的能力），
 * 因此产品之间不复制装配逻辑 —— 新增能力时改的是"声明"，不是"再写一遍"。
 */

/** 产品 id：进装配快照，也是恢复会话时的身份校验依据（换 recipe 恢复会被拒绝）。 */
export const CUBUS_CODING_AGENT_ID = 'cubus-coding-agent'

/** 产品版本：能力面发生不兼容变化时递增。 */
export const CUBUS_CODING_AGENT_VERSION = '0.1.0'

/**
 * 产品角色提示词。
 *
 * 只写"这个产品是什么、怎么干活、边界在哪"，不写项目约定（那属于工作区的指令文件，
 * 由后续的记忆/指令能力注入）—— 这样同一份提示词能跨项目复用并命中同一段缓存。
 */
export const CUBUS_CODING_AGENT_PROMPT = [
  '你是 Cubus CodingAgent：运行在 CubusAgent 运行时之上的编码 Agent 产品。',
  '工作方式：先读代码与项目约束，再做范围尽可能小且完整的修改；改动后运行相关检查，依据真实结果继续。',
  '可用工具：read_file、edit_file、write_file、bash。',
  '边界：每次工具调用都要经过审批策略与预算护栏；你的每一步请求与工具结果都会写入会话日志，可回放、可审计。',
  '完成时简要说明改动、验证结果与仍存在的风险。',
].join('\n')

/** 产品装配：与 repair-eval 共用同一个工厂，产物是一份声明而不是一份新实现。 */
export const cubusCodingAgentRecipe = createCodingAgentRecipe({
  id: CUBUS_CODING_AGENT_ID,
  version: CUBUS_CODING_AGENT_VERSION,
  displayName: 'Cubus CodingAgent',
  description: '在受信工作区里读写代码、运行命令并验证结果的编码 Agent 产品。',
  defaultSystemPrompt: CUBUS_CODING_AGENT_PROMPT,
  permissionProfile: 'ask',
})
