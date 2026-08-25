import type { ProjectedRequest, RequestToolSpec } from '@cubus/session'

/**
 * llm seam 的 Service Definition：模型适配器接口。
 *
 * 任何模型供应商（DeepSeek、假模型、未来的任何家）都实现这个接口；
 * 消费方（循环）只依赖接口，不依赖具体实现——换供应商 = 换 Provider。
 */
export interface LlmAdapter {
  /** Stable route identity recorded in request/header before every dispatch. */
  readonly provider: string
  readonly model: string
  stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmChunk, void, void>
}

/** 模型可用的工具 schema（发给 provider 的 tools 字段）。 */
export type LlmToolSpec = RequestToolSpec

/** 一次模型请求；由 request/header 与此前日志消息纯投影重建。 */
export type LlmRequest = ProjectedRequest

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
