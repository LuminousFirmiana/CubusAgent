import type { Context } from '@cubus/cordis'
import type { SessionLog } from '@cubus/session'
import { SessionLogFile } from './log.ts'

declare module '@cubus/cordis' {
  interface Context {
    sessionLog: SessionLog
  }
}

export interface JsonlSessionPluginConfig {
  path: string
}

/** Host provider for one session's append-only JSONL log. */
export const jsonlSessionPlugin = {
  name: 'session-jsonl',
  apply(ctx: Context, config: JsonlSessionPluginConfig) {
    ctx.provide('sessionLog', new SessionLogFile(config.path))
  },
}
