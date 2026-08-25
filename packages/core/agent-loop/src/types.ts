import type { LlmAdapter } from '@cubus/llm'
import type { ContentBlock, SessionLog } from '@cubus/session'
import type { Tool } from '@cubus/tool-registry'

export type { Tool } from '@cubus/tool-registry'

/** One immutable prompt/tool view used for an entire model/tool step. */
export interface StepCapabilities {
  systemPrompt?: string
  tools: readonly Tool[]
}

/** 循环配置：日志（事实源）+ 适配器（llm seam）+ 工具 + ID 生成器。 */
export interface LoopConfig {
  log: SessionLog
  adapter: LlmAdapter
  /** Static compatibility path for direct Loop users. */
  tools: readonly Tool[]
  /** 系统提示：随每次模型请求传出（适配器映射为 provider 的 system 消息）。 */
  systemPrompt?: string
  /** Dynamic composition path. Called exactly once before each step starts. */
  resolveCapabilities?: () => StepCapabilities
  /** 默认随机；测试注入计数器实现确定性回放。 */
  generateId?: () => string
}

/** 收件箱里的一条待处理输入。 */
export interface InboxItem {
  messageId: string
  content: ContentBlock[]
}
