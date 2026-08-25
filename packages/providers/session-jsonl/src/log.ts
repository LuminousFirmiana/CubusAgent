import { appendFile, readFile } from 'node:fs/promises'
import type { SessionEvent, SessionLog, SessionLogReadResult } from '@cubus/session'

export class SessionLogCorruptionError extends Error {
  line: number

  constructor(line: number, cause: unknown) {
    super(`session log corruption at line ${line}: ${String(cause)}`)
    this.name = 'SessionLogCorruptionError'
    this.line = line
  }
}

/** Single-writer append-only JSONL provider with final-line crash recovery. */
export class SessionLogFile implements SessionLog {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  async append(event: SessionEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n'
    await appendFile(this.path, line, 'utf8')
  }

  async read(): Promise<SessionLogReadResult> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], truncated: false }
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
