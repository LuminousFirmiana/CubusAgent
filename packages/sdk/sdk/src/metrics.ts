import type { SessionEvent } from '@cubus/session'
import { listSessions, readSessionEvents } from './sessions.ts'

/**
 * 观测指标（F4）：**只从会话日志算**，不引入第二份事实源。
 *
 * 能算的：回合数 / 取消回合 / 恢复结算 / 步数 / 工具调用（成功、失败、审批拦截、按工具名）/
 * token（含缓存命中）。算不出来的两件（诚实记录，见 docs/handover.md 的技术债）：
 * - **耗时**：日志里没有时间戳；
 * - **重试率**：llm-retry 的重试没有写进日志。
 */

export interface SessionMetrics {
  readonly sessionId: string
  readonly events: number
  /** turn/start 的数量。 */
  readonly turns: number
  /** 被取消的回合：assistant/message 带 interrupted: true。 */
  readonly cancelledTurns: number
  /** 恢复时补写的回合闭合（turn/end 带 settled: true）。 */
  readonly settledTurns: number
  readonly steps: number
  readonly toolCalls: number
  /** 执行失败的调用（tool/result ok:false，含被审批拒绝的）。 */
  readonly toolFailures: number
  /** 审批拦截（拒绝或超时未回答）—— 拦截率的分子。 */
  readonly toolDenials: number
  readonly toolCallsByName: Readonly<Record<string, number>>
  readonly tokens: {
    readonly prompt: number
    readonly completion: number
    readonly total: number
    /** 命中缓存的 prompt token（provider 支持时）。 */
    readonly cached: number
  }
  /** 带 usage 的助手消息数（用来判断 token 数字覆盖了多少回合）。 */
  readonly usageMessages: number
  readonly needsSettlement: boolean
}

const DENIED_PREFIX = 'tool denied by approval policy'

export function sessionMetrics(sessionId: string, events: readonly SessionEvent[]): SessionMetrics {
  let turns = 0
  let cancelledTurns = 0
  let settledTurns = 0
  let steps = 0
  let toolCalls = 0
  let toolFailures = 0
  let toolDenials = 0
  let usageMessages = 0
  let openTurn = false
  const byName: Record<string, number> = {}
  const tokens = { prompt: 0, completion: 0, total: 0, cached: 0 }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turns += 1
        openTurn = true
        break
      case 'turn/end':
        if (event.settled === true) settledTurns += 1
        openTurn = false
        break
      case 'step/start':
        steps += 1
        break
      case 'tool/call':
        toolCalls += 1
        byName[event.name] = (byName[event.name] ?? 0) + 1
        break
      case 'tool/result': {
        const text = event.output.text
        const denied = text.startsWith(DENIED_PREFIX)
        if (denied) toolDenials += 1
        if (event.ok !== true) toolFailures += 1
        break
      }
      case 'assistant/message':
        if (event.interrupted === true) cancelledTurns += 1
        if (event.usage !== undefined) {
          usageMessages += 1
          tokens.prompt += event.usage.promptTokens
          tokens.completion += event.usage.completionTokens
          tokens.total += event.usage.totalTokens
          tokens.cached += event.usage.cachedTokens ?? 0
        }
        break
      default:
        break
    }
  }

  return {
    sessionId,
    events: events.length,
    turns,
    cancelledTurns,
    settledTurns,
    steps,
    toolCalls,
    toolFailures,
    toolDenials,
    toolCallsByName: byName,
    tokens,
    usageMessages,
    needsSettlement: openTurn,
  }
}

export interface MetricsSummary {
  readonly sessions: readonly SessionMetrics[]
  readonly totals: {
    readonly sessions: number
    readonly turns: number
    readonly cancelledTurns: number
    readonly settledTurns: number
    readonly steps: number
    readonly toolCalls: number
    readonly toolFailures: number
    readonly toolDenials: number
    readonly tokens: SessionMetrics['tokens']
    readonly usageMessages: number
    readonly toolCallsByName: Readonly<Record<string, number>>
  }
  /**
   * 比率：分母为 0 时是 **null**（"没有数据"），不是 0 也不是 NaN —— 0 会被误读成"确实没发生"。
   */
  readonly rates: {
    readonly toolDenial: number | null
    readonly toolFailure: number | null
    readonly turnCancellation: number | null
    /** 平均每个有产出的回合花了多少 token。 */
    readonly tokensPerUsageMessage: number | null
  }
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

export function summarizeMetrics(sessions: readonly SessionMetrics[]): MetricsSummary {
  const totals = {
    sessions: sessions.length,
    turns: 0,
    cancelledTurns: 0,
    settledTurns: 0,
    steps: 0,
    toolCalls: 0,
    toolFailures: 0,
    toolDenials: 0,
    usageMessages: 0,
    tokens: { prompt: 0, completion: 0, total: 0, cached: 0 },
    toolCallsByName: {} as Record<string, number>,
  }

  for (const session of sessions) {
    totals.turns += session.turns
    totals.cancelledTurns += session.cancelledTurns
    totals.settledTurns += session.settledTurns
    totals.steps += session.steps
    totals.toolCalls += session.toolCalls
    totals.toolFailures += session.toolFailures
    totals.toolDenials += session.toolDenials
    totals.usageMessages += session.usageMessages
    totals.tokens.prompt += session.tokens.prompt
    totals.tokens.completion += session.tokens.completion
    totals.tokens.total += session.tokens.total
    totals.tokens.cached += session.tokens.cached
    for (const [name, count] of Object.entries(session.toolCallsByName)) {
      totals.toolCallsByName[name] = (totals.toolCallsByName[name] ?? 0) + count
    }
  }

  return {
    sessions,
    totals,
    rates: {
      toolDenial: ratio(totals.toolDenials, totals.toolCalls),
      toolFailure: ratio(totals.toolFailures, totals.toolCalls),
      turnCancellation: ratio(totals.cancelledTurns, totals.turns),
      tokensPerUsageMessage: ratio(totals.tokens.total, totals.usageMessages),
    },
  }
}

/** 读一个会话目录下的全部会话并汇总（复用 SDK 的读取侧，容错半行）。 */
export async function collectMetrics(rootDir: string): Promise<MetricsSummary> {
  const summaries = await listSessions(rootDir)
  const sessions: SessionMetrics[] = []
  for (const summary of summaries) {
    const { events } = await readSessionEvents(summary.logPath)
    sessions.push(sessionMetrics(summary.id, events))
  }
  return summarizeMetrics(sessions)
}
