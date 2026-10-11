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
  /**
   * 时长窗口的起点。**不是装配时刻**：工作台里一个会话能反复运行，装配时刻起算会让
   * "打开超过 10 分钟的会话"之后每次运行都被判超时。窗口挂在回合边界上（回合 = 一次运行）。
   */
  private windowStartedAt: number
  /** 回合闭合的时刻；有值表示"当前不在回合里"，此时不判时长。 */
  private windowEndedAt: number | undefined
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
    this.windowStartedAt = options.now ?? Date.now()
    // 还没进回合 = 窗口是闭合的：会话闲置多久都不算"跑飞"，elapsedMs 也从 0 起算。
    this.windowEndedAt = this.windowStartedAt
    // 历史只计数：恢复续跑时窗口从"这次恢复"起算（崩溃前那段墙钟无法也无需累计）
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

  /**
   * 观察一条已落盘的事件（插件订阅日志而来）。
   *
   * 回合边界同时是**时长窗口**的边界：
   * - `turn/start`：开新窗口、清掉上一回合的超限结论（步数/工具/token 仍跨回合累计）；
   * - `turn/end`：闭合窗口（此后不判时长，空闲时间不算预算）；
   * - 其余事件：计数并评估。
   */
  observe(event: SessionEvent, now: number = Date.now()): void {
    if (event.type === 'turn/start') {
      this.windowStartedAt = now
      this.windowEndedAt = undefined
      this.trippedReason = undefined
      return
    }
    if (event.type === 'turn/end') {
      this.windowEndedAt = now
      return
    }
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
    // 时长只在**回合内**评估：会话开着不管多久都不算"跑飞"（工作台里会话是长期开着的）。
    // 步数 / 工具 / token 是会话级累计值，照旧在任何事件上评估。
    if (
      maxDurationMs !== undefined && this.windowEndedAt === undefined &&
      now - this.windowStartedAt > maxDurationMs
    ) return 'max-duration'
    if (maxTokens !== undefined && this.tokens > maxTokens) return 'max-tokens'
    return undefined
  }

  state(now: number = Date.now()): BudgetState {
    return {
      steps: this.steps,
      toolCalls: this.toolCalls,
      tokens: this.tokens,
      // 回合结束后冻结为"本次运行用时"（工作台/CLI 展示的就是这个数）
      elapsedMs: Math.max(0, (this.windowEndedAt ?? now) - this.windowStartedAt),
      ...(this.trippedReason === undefined ? {} : { tripped: this.trippedReason }),
    }
  }
}
