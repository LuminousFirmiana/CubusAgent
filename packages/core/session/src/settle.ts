import type { SessionEvent, StepId, ToolCallId, TurnId } from './types.ts'

/**
 * 恢复与结算（D3；设计见 docs/design/eval-suite-and-resume.md §5）。
 *
 * 崩溃会在日志尾部留下三种尾巴，必须由**新进程**在继续之前补齐：
 * - 未闭合 turn/step：补闭合事件（带 settled: true，与正常收尾可区分）；
 * - 孤儿 tool/call（有调用无结果）：补一条"结果未知"的 tool/result ——
 *   不是为了好看，而是协议要求：下一轮请求里 assistant 的 tool_calls 必须与 tool 消息配对。
 *
 * 本模块是**纯函数**：只规划、不写日志（写入由调用方决定，便于单测）。
 */

/** 恢复时写给孤儿工具调用的结果文本：明确说"不知道"，既不谎称成功也不谎称失败。 */
export const UNKNOWN_TOOL_RESULT_TEXT =
  'unknown: the session stopped before this tool result was recorded'

export interface SettlementPlan {
  /** 未闭合的 turn（如果有）。 */
  readonly unclosedTurn?: TurnId
  /** 未闭合的 step（按日志顺序）。 */
  readonly unclosedSteps: readonly StepId[]
  /** 有调用无结果的工具（按日志顺序）。 */
  readonly orphanToolCalls: readonly ToolCallId[]
}

/** 扫描日志尾部状态（全局配对，不假设日志一定良构）。 */
export function planSettlement(events: readonly SessionEvent[]): SettlementPlan {
  const stepStarts: StepId[] = []
  const closedSteps = new Set<StepId>()
  const toolCalls: ToolCallId[] = []
  const toolResults = new Set<ToolCallId>()
  let openTurn: TurnId | undefined

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = event.turnId
        break
      case 'turn/end':
        openTurn = undefined
        break
      case 'step/start':
        stepStarts.push(event.stepId)
        break
      case 'step/end':
        closedSteps.add(event.stepId)
        break
      case 'tool/call':
        toolCalls.push(event.id)
        break
      case 'tool/result':
        toolResults.add(event.id)
        break
      default:
        break
    }
  }

  return {
    ...(openTurn === undefined ? {} : { unclosedTurn: openTurn }),
    unclosedSteps: stepStarts.filter(stepId => !closedSteps.has(stepId)),
    orphanToolCalls: toolCalls.filter(id => !toolResults.has(id)),
  }
}

/** 日志已经是闭合的（无需结算）。 */
export function isSettled(plan: SettlementPlan): boolean {
  return plan.unclosedTurn === undefined &&
    plan.unclosedSteps.length === 0 &&
    plan.orphanToolCalls.length === 0
}

/** 结算事件：顺序为「孤儿结果 -> step 闭合 -> turn 闭合」（保持嵌套顺序）。 */
export function settlementEvents(plan: SettlementPlan): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const id of plan.orphanToolCalls) {
    events.push({ type: 'tool/result', id, ok: false, output: { text: UNKNOWN_TOOL_RESULT_TEXT } })
  }
  for (const stepId of plan.unclosedSteps) {
    events.push({ type: 'step/end', stepId, settled: true })
  }
  if (plan.unclosedTurn !== undefined) {
    events.push({ type: 'turn/end', turnId: plan.unclosedTurn, settled: true })
  }
  return events
}
