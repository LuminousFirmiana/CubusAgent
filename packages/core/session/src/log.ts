import type { SessionEvent } from './types.ts'

/** 一次读取的结果：完整事件序列 + 是否检测到末尾截断。 */
export interface SessionLogReadResult {
  events: SessionEvent[]
  truncated: boolean
}

/** Storage seam consumed by the loop. Implementations own durability details. */
export interface SessionLog {
  append(event: SessionEvent): Promise<void>
  read(): Promise<SessionLogReadResult>
}
