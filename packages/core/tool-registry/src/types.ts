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

/**
 * 工具来源标签（可选、additive，S2.1）。
 *
 * - **缺省 = 产品自带的内建工具**：必须在 manifest.tools 里逐个申报名字；
 * - **有值 = 来自某个动态工具来源**（例如 `'mcp'`）：产品在 manifest.toolSources 里申报
 *   "本产品还会从这些来源拿工具"即可，不必逐个写名字 —— 因为它们的名字运行时才知道。
 *
 * 它不是模型可见内容：不进工具定义、不进请求、不进投影，只用于装配期校验与审计。
 */
export type ToolSource = string

/** 注册表快照里的一项：工具本身 + 来源标签（缺省 = 内建）。 */
export type RegisteredTool = Tool & { readonly source?: ToolSource }
