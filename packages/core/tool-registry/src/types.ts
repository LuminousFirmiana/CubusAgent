/** Per-invocation runtime state. Keep policy/product concerns out of this context. */
export interface ToolExecutionContext {
  readonly signal: AbortSignal
}

/** Provider-neutral model tool contract. Product plugins own concrete tools. */
export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: unknown, context: ToolExecutionContext): Promise<string> | string
}
