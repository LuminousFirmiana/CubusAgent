import { appendFile, readFile } from 'node:fs/promises'
import type { SessionEvent } from './types.ts'

export class SessionLogCorruptionError extends Error {
  line: number

  constructor(line: number, cause: unknown) {
    super(`session log corruption at line ${line}: ${String(cause)}`)
    this.name = 'SessionLogCorruptionError'
    this.line = line
  }
}

/** 一次读取的结果：完整事件序列 + 是否检测到末尾截断。 */
export interface SessionLogReadResult {
  events: SessionEvent[]
  truncated: boolean
}

/**
 * Append-only 会话日志文件。
 *
 * 写入约定：每事件一次 appendFile 调用，JSON.stringify 转义换行，
 * 因此文件里一行恒等于一个完整事件；进程在写入中途被杀只会留下
 * 残缺的最后一"行"（半行 JSON），读取时报告 truncated 并丢弃。
 *
 * 使用约定：单进程内顺序调用 append；不支持并发追加。
 */

export class SessionLogFile {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  /**
   * 追加一个事件。不可序列化的参数（BigInt、循环引用）在落盘前
   * 就被 JSON.stringify 抓住并抛出，而不是变成一行坏 JSON。
   */
  async append(event: SessionEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n'
    await appendFile(this.path, line, 'utf8')
  }

  async read(): Promise<SessionLogReadResult> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { events: [], truncated: false }
      }
      throw error
    }

    const lines = raw.split('\n')
    const events: SessionEvent[] = []
    let truncated = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line === undefined || line === '') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        if (i === lines.length - 1) {
          truncated = true
          continue
        }
        throw new SessionLogCorruptionError(i + 1, error)
      }
      if (typeof parsed !== 'object' || parsed === null || !('type' in parsed) || typeof (parsed as { type: unknown }).type !== 'string') {
        throw new SessionLogCorruptionError(i + 1, 'not a session event')
      }
      events.push(parsed as SessionEvent)
    }
    return { events, truncated }
  }
}

