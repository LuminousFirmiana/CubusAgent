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
