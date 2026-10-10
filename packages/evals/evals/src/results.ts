import type { BudgetTripReason } from '@cubus/sdk'
import type { EvalGateLevel } from './suites.ts'

/**
 * 机器可读的评测结果（D2）：`EVALS.md` 给人看，这份给门禁 / 工作台看。
 * 纯渲染函数，便于单测（不碰文件系统）。
 */

export interface EvalTaskOutcome {
  readonly id: string
  readonly passed: boolean
  readonly durationMs: number
  readonly logPath: string
  readonly gate?: EvalGateLevel
  /** 与 golden 的回归门禁结果（没有 golden 的任务缺省）。 */
  readonly regression?: { readonly ok: boolean; readonly differences: readonly string[] }
  /** 本任务的 token 用量（F4：指标与分数同一张表；读日志里的 usage）。 */
  readonly tokens?: { readonly total: number; readonly cached: number }
  /**
   * 被预算拦住的原因（若有）。
   * 语义：**跑飞了**，不是"答错了"——分数表里必须能一眼区分这两件事。
   */
  readonly budgetTripped?: BudgetTripReason
}

export interface EvalRunSummary {
  /** ISO 时间戳。 */
  readonly ranAt: string
  readonly model: string
  readonly suiteId: string
  readonly suiteVersion: string
  readonly passed: number
  readonly total: number
  readonly outcomes: readonly EvalTaskOutcome[]
}

export function renderLatestResult(summary: EvalRunSummary): string {
  return JSON.stringify(summary, null, 2) + '\n'
}
