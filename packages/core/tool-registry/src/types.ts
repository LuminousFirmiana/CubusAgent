/** Per-invocation runtime state. Keep policy/product concerns out of this context. */
export interface ToolExecutionContext {
  readonly signal: AbortSignal
  /**
   * 本次执行所属的会话（可选、additive）。
   * 用途：让**策略**（例如审批）知道"是哪个会话在请求"，多会话并发时能按会话归属展示与控制。
   * 它不改变工具语义，也不是模型可见内容。
   */
  readonly sessionId?: string
}

/** Provider-neutral model tool contract. Product plugins own concrete tools. */
export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: unknown, context: ToolExecutionContext): Promise<string> | string
}
