import type { ContentBlock, ProjectedMessage, SessionLogFile } from '@cubus/session'

/**
 * 模型适配器接口（llm seam 的雏形，S1.3 拆成独立包）。
 * 消费方只有循环一个：stream 产出碎片，循环负责落日志。
 */
export interface LlmAdapter {
  stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmChunk, void, void>
}

/** 一次模型请求：投影后的消息序列（system prompt 留到 S1.3）。 */
export interface LlmRequest {
  messages: ProjectedMessage[]
}

/**
 * 模型流的一个碎片。
 * - delta / thinkingDelta：正文与思考的增量（分开发，不混合）；
 * - toolCalls：模型请求的工具调用，出现在流的末尾碎片上；
 *   有 toolCalls 的碎片可以同时没有 delta（纯工具调用步）。
 */
export interface LlmChunk {
  delta?: string
  thinkingDelta?: string
  toolCalls?: LlmToolCall[]
}

/** 模型请求的一次工具调用。 */
export interface LlmToolCall {
  id: string
  name: string
  args: unknown
}

/**
 * 工具定义：v1 的 execute 返回文本（JSON 可序列化，直接进日志）。
 * 抛错时由循环捕获，记为 ok: false 的结果。
 */
export interface Tool {
  name: string
  execute(args: unknown): Promise<string> | string
}

/** 循环配置：日志（事实源）+ 适配器 + 工具 + ID 生成器（可注入实现确定性）。 */
export interface LoopConfig {
  log: SessionLogFile
  adapter: LlmAdapter
  tools: Tool[]
  /** 默认随机；测试注入计数器实现确定性回放。 */
  generateId?: () => string
}

/** 收件箱里的一条待处理输入。 */
export interface InboxItem {
  messageId: string
  content: ContentBlock[]
}

