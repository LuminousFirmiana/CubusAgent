import type { AgentHost, HostCapabilityOffering } from '@cubus/agent-recipe'
import type { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import { UnconfinedSandbox } from '@cubus/sandbox'
import { jsonlSessionPlugin } from '@cubus/session-jsonl'
import { LocalFs, LocalSubprocess } from '@cubus/tools'

export interface LocalAgentHostOptions {
  /** Called once per session so stateful adapters are never shared across sessions. */
  adapterFactory: () => LlmAdapter
  /** 工作区绝对路径：fs 的根、bash 的 cwd。部署参数，由 app 提供。 */
  workspaceDir: string
}

/**
 * Local single-process Host. Product prompt and tools remain Recipe concerns.
 *
 * 能力声明（B4）：llm / session-log / fs / subprocess 四项。
 * - features 是"本 Host 保证具备"的特性，由构造方（app）负责选对适配器与路径；
 * - workspaceDir 不是能力而是环境事实，随 fs offering 一起提供给 Recipe；
 * - 沙箱与凭据能力（P5）加入这张表后，同一 Recipe 可切到容器化 Host 而不改代码。
 */
export function createLocalAgentHost(options: LocalAgentHostOptions): AgentHost {
  const subprocess = new LocalSubprocess()
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
    {
      kind: 'fs',
      provider: 'local',
      features: ['read', 'write'],
      mount(ctx: Context) {
        ctx.provide('fs', new LocalFs(options.workspaceDir))
        ctx.provide('workspaceDir', options.workspaceDir)
      },
    },
    {
      kind: 'subprocess',
      provider: 'local',
      features: ['cancellation', 'process-group-kill'],
      mount(ctx: Context) {
        ctx.provide('subprocess', subprocess)
      },
    },
    {
      // 诚实声明：本地没有隔离。需要 sandbox[fs-isolation] 的 recipe
      // 因此会在装配期失败，而不是静默降级（见 docs/design/sandbox-seam.md §2）。
      kind: 'sandbox',
      provider: 'local-unconfined',
      features: ['unconfined'],
      mount(ctx: Context) {
        ctx.provide('sandbox', new UnconfinedSandbox())
      },
    },
  ]

  return {
    capabilities: () => offerings,
    async mount(ctx: Context, session, selection) {
      // 直接使用 Host（不经协商）时挂载全部能力；协商路径只挂选中的。
      for (const offering of selection ?? offerings) {
        await offering.mount(ctx, session)
      }
    },
  }
}
