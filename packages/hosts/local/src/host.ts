import type { AgentHost, HostCapabilityOffering } from '@cubus/agent-recipe'
import type { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import { jsonlSessionPlugin } from '@cubus/session-jsonl'

export interface LocalAgentHostOptions {
  /** Called once per session so stateful adapters are never shared across sessions. */
  adapterFactory: () => LlmAdapter
}

/**
 * Local single-process Host. Product prompt and tools remain Recipe concerns.
 *
 * 能力声明（B3）：本 Host 提供 llm 与 session-log 两项。
 * features 描述的是"本 Host 保证适配器具备这些能力"，由构造方（app）负责选对适配器。
 * 文件系统/子进程/git/沙箱等能力在 B4/P5 迁入 Host 后加入这张表。
 */
export function createLocalAgentHost(options: LocalAgentHostOptions): AgentHost {
  const offerings: readonly HostCapabilityOffering[] = [
    {
      kind: 'llm',
      provider: 'local-adapter',
      features: ['tool-calling', 'streaming'],
      mount(ctx: Context) {
        ctx.provide('llm', options.adapterFactory())
      },
    },
    {
      kind: 'session-log',
      provider: 'jsonl',
      features: ['live-subscribe'],
      async mount(ctx: Context, session) {
        await ctx.plugin(jsonlSessionPlugin, { path: session.logPath })
      },
    },
  ]

  return {
    capabilities: () => offerings,
    async mount(ctx: Context, session, selection) {
      // legacy 装配不给 selection：按本 Host 的默认行为挂载全部能力。
      for (const offering of selection ?? offerings) {
        await offering.mount(ctx, session)
      }
    },
  }
}
