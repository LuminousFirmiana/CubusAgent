import type { AgentHost } from '@cubus/agent-recipe'
import type { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import { jsonlSessionPlugin } from '@cubus/session-jsonl'

export interface LocalAgentHostOptions {
  /** Called once per session so stateful adapters are never shared across sessions. */
  adapterFactory: () => LlmAdapter
}

/** Local single-process Host. Product prompt and tools remain Recipe concerns. */
export function createLocalAgentHost(options: LocalAgentHostOptions): AgentHost {
  return {
    async mount(ctx: Context, session) {
      ctx.provide('llm', options.adapterFactory())
      await ctx.plugin(jsonlSessionPlugin, { path: session.logPath })
    },
  }
}
