import type { BudgetLimits, SessionEvent } from '@cubus/session'

export type BudgetTripReason = 'max-steps' | 'max-tool-calls' | 'max-duration' | 'max-tokens'

export interface BudgetState {
  readonly steps: number
  readonly toolCalls: number
  readonly elapsedMs: number
  /** 累计 token（读 assistant/message.usage；provider 未提供时不增长）。 */
  readonly tokens: number
  /** 首次超限的原因；未超限为 undefined。 */
  readonly tripped?: BudgetTripReason
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(name + ' must be a positive integer, got ' + String(value))
  }
}

/**
 * 预算策略（C5）：数步数、工具调用与墙钟时长，超限触发一次取消。
 *
 * 它是**纯策略 + 计数器**：不认识 cordis，也不写日志 —— 由插件把它接到
 * 会话日志订阅与 loop.cancel() 上。因此这里可以逐条喂事件来单测。
 */
export class BudgetPolicy {
  readonly limits: BudgetLimits
  private readonly onTrip: (reason: BudgetTripReason) => void
  private readonly startedAt: number
  private steps = 0
  private toolCalls = 0
  private tokens = 0
  private trippedReason: BudgetTripReason | undefined

  constructor(options: {
    limits: BudgetLimits
    onTrip: (reason: BudgetTripReason) => void
    now?: number
    /** 恢复时喂入的历史事件：只计数、不 trip（D1 §5.4：步数/工具数跨崩溃累计）。 */
    history?: readonly SessionEvent[]
  }) {
    const { limits } = options
    if (limits.maxSteps !== undefined) assertPositiveInteger(limits.maxSteps, 'maxSteps')
    if (limits.maxToolCalls !== undefined) assertPositiveInteger(limits.maxToolCalls, 'maxToolCalls')
    if (limits.maxDurationMs !== undefined) assertPositiveInteger(limits.maxDurationMs, 'maxDurationMs')
    if (limits.maxTokens !== undefined) assertPositiveInteger(limits.maxTokens, 'maxTokens')
    if (
      limits.maxSteps === undefined && limits.maxToolCalls === undefined &&
      limits.maxDurationMs === undefined && limits.maxTokens === undefined
    ) {
      throw new TypeError('budget must define at least one limit')
    }
    this.limits = limits
    this.onTrip = options.onTrip
    this.startedAt = options.now ?? Date.now()
    for (const event of options.history ?? []) this.count(event)
  }

  /** 只做计数（历史回放用；不评估是否超限）。 */
  private count(event: SessionEvent): void {
    if (event.type === 'step/start') this.steps += 1
    if (event.type === 'tool/call') this.toolCalls += 1
    if (event.type === 'assistant/message' && event.usage !== undefined) {
      this.tokens += event.usage.totalTokens
    }
  }

  /** 观察一条已落盘的事件（插件订阅日志而来）。 */
  observe(event: SessionEvent, now: number = Date.now()): void {
    this.count(event)
    this.check(now)
  }

  /** 检查是否超限；超限时只触发一次取消。 */
  check(now: number = Date.now()): void {
    if (this.trippedReason !== undefined) return
    const reason = this.evaluate(now)
    if (reason === undefined) return
    this.trippedReason = reason
    this.onTrip(reason)
  }

  private evaluate(now: number): BudgetTripReason | undefined {
    const { maxSteps, maxToolCalls, maxDurationMs, maxTokens } = this.limits
    if (maxSteps !== undefined && this.steps > maxSteps) return 'max-steps'
    if (maxToolCalls !== undefined && this.toolCalls > maxToolCalls) return 'max-tool-calls'
    if (maxDurationMs !== undefined && now - this.startedAt > maxDurationMs) return 'max-duration'
    if (maxTokens !== undefined && this.tokens > maxTokens) return 'max-tokens'
    return undefined
  }

  state(now: number = Date.now()): BudgetState {
    return {
      steps: this.steps,
      toolCalls: this.toolCalls,
      tokens: this.tokens,
      elapsedMs: Math.max(0, now - this.startedAt),
      ...(this.trippedReason === undefined ? {} : { tripped: this.trippedReason }),
    }
  }
}
