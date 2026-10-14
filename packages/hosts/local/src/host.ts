import type { AgentHost, HostCapabilityOffering } from '@cubus/agent-recipe'
import type { CredentialsProvider } from '@cubus/credentials'
import type { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import { SeatbeltSandbox, UnconfinedSandbox } from '@cubus/sandbox'
import type { SandboxProvider } from '@cubus/sandbox'
import { jsonlSessionPlugin } from '@cubus/session-jsonl'
import { LocalFs, LocalSubprocess } from '@cubus/tools'

export interface LocalAgentHostOptions {
  /** Called once per session so stateful adapters are never shared across sessions. */
  adapterFactory: () => LlmAdapter
  /** 工作区绝对路径：fs 的根、bash 的 cwd。部署参数，由 app 提供。 */
  workspaceDir: string
  /**
   * 凭据来源（可选）：提供时本 Host 声明 credentials 能力，
   * features 就是可发放的凭据名（只有名字，没有值）。
   */
  credentials?: CredentialsProvider
  /**
   * 沙箱档（S5.2）：`unconfined`（默认，诚实声明无隔离）或 `seatbelt`（macOS 内核 seatbelt）。
   * 选 `seatbelt` 但本机不可用 → **装配期失败**，绝不静默降级成无隔离执行。
   */
  sandbox?: 'unconfined' | 'seatbelt'
  /** seatbelt 档：是否允许网络出口（默认不允许）。 */
  allowNetwork?: boolean
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
  const plainSubprocess = new LocalSubprocess()
  // 沙箱档（S5.2）：seatbelt 时把每条命令包进 sandbox-exec；unconfined 时保持原样。
  const sandboxProvider: SandboxProvider = options.sandbox === 'seatbelt'
    ? new SeatbeltSandbox({
        workspaceDir: options.workspaceDir,
        ...(options.allowNetwork === undefined ? {} : { allowNetwork: options.allowNetwork }),
      })
    : new UnconfinedSandbox()
  const seatbelt = sandboxProvider instanceof SeatbeltSandbox ? sandboxProvider : undefined
  const subprocess = seatbelt === undefined
    ? plainSubprocess
    : {
        run: (command: string, runOptions: { cwd: string; signal: AbortSignal; timeoutMs?: number }) =>
          plainSubprocess.run(seatbelt.wrap(command), runOptions),
      }
  const credentials = options.credentials
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
      // 诚实声明：unconfined 就是"没有隔离"；seatbelt 只承诺"写隔离 + 断网"，
      // 需要 fs-isolation 的 recipe 在这两档上都会装配期失败（见 docs/design/sandbox-seam.md §2）。
      kind: 'sandbox',
      provider: sandboxProvider.provider,
      features: [...sandboxProvider.features],
      mount(ctx: Context) {
        // fail-closed：选了这一档但执行器不在，就在这里失败，而不是跑起来才发现没有隔离
        if (seatbelt !== undefined) seatbelt.assertAvailable()
        ctx.provide('sandbox', sandboxProvider)
      },
    },
    ...(credentials === undefined ? [] : [{
      // 凭据能力：features 是名字白名单（值永远不进快照）。
      kind: 'credentials' as const,
      provider: credentials.provider,
      features: [...credentials.names],
      mount(ctx: Context) {
        ctx.provide('credentials', credentials)
      },
    }]),
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