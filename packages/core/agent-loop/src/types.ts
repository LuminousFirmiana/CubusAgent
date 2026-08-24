import type { LlmAdapter } from '@cubus/llm'
import type { ContentBlock, SessionLogFile } from '@cubus/session'

/**
 * 工具定义：v1 的 execute 返回文本（JSON 可序列化，直接进日志）。
 * 抛错时由循环捕获，记为 ok: false 的结果。
 * description + parameters 是给模型看的 schema（随请求发给 API），
 * 模型只有收到它们才会真正发起工具调用，而不是在正文里幻觉出调用文本。
 */
export interface Tool {
  name: string
  description: string
  /** JSON Schema（对象型）：模型据此生成合法参数。 */
  parameters: Record<string, unknown>
  execute(args: unknown): Promise<string> | string
}

/** 循环配置：日志（事实源）+ 适配器（llm seam）+ 工具 + ID 生成器。 */
export interface LoopConfig {
  log: SessionLogFile
  adapter: LlmAdapter
  tools: Tool[]
  /** 系统提示：随每次模型请求传出（适配器映射为 provider 的 system 消息）。 */
  systemPrompt?: string
  /** 默认随机；测试注入计数器实现确定性回放。 */
  generateId?: () => string
}

/** 收件箱里的一条待处理输入。 */
export interface InboxItem {
  messageId: string
  content: ContentBlock[]
}

