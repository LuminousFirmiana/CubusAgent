import type { SessionEvent } from './types.ts'

/** 一次读取的结果：完整事件序列 + 是否检测到末尾截断。 */
export interface SessionLogReadResult {
  events: SessionEvent[]
  truncated: boolean
}

/** 实时订阅回调：与落盘事件完全相同，顺序一致。 */
export type SessionLogListener = (event: SessionEvent) => void

/**
 * Storage seam consumed by the loop. Implementations own durability details.
 */
export interface SessionLog {
  append(event: SessionEvent): Promise<void>
  read(): Promise<SessionLogReadResult>
  /**
   * 订阅后续 append 的事件，返回取消订阅函数。
   *
   * 事件流是**日志的实时视图**，不是第二个状态源：回调参数与落盘事件完全相同，
   * 且只在事件已经持久化之后才回调（因此"流上看到"蕴含"日志里已记录"）。
   * 可选能力：不支持实时流的 provider 可以不实现，消费方必须容忍 undefined。
   */
  subscribe?(listener: SessionLogListener): () => void
}
