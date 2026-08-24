import type { ProjectedMessage } from '@cubus/session'

/**
 * llm seam 的 Service Definition：模型适配器接口。
 *
 * 任何模型供应商（DeepSeek、假模型、未来的任何家）都实现这个接口；
 * 消费方（循环）只依赖接口，不依赖具体实现——换供应商 = 换 Provider。
 */
export interface LlmAdapter {
  stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmChunk, void, void>
}

/** 一次模型请求：投影后的消息序列 + 可选系统提示。 */
export interface LlmRequest {
  messages: ProjectedMessage[]
  /** 系统提示：适配器映射为 provider 的 system 消息（OpenAI 系为 role: system）。 */
  systemPrompt?: string
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

