import { existsSync, realpathSync } from 'node:fs'
import { SANDBOX_FEATURES } from './features.ts'
import type { SandboxFeature } from './features.ts'
import type { SandboxProvider } from './types.ts'

/** macOS 自带的沙箱执行器（内核 seatbelt）。 */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec'

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SandboxUnavailableError'
  }
}

/** 规范化路径（不存在时退回原值：规则先写好，目录随后创建也能用上）。 */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

export interface SeatbeltOptions {
  /** 允许写的工作区（其余路径一律拒绝写）。 */
  readonly workspaceDir: string
  /** 允许网络出口（默认**不允许**）。 */
  readonly allowNetwork?: boolean
  /** 额外允许写的路径（例如临时目录）。 */
  readonly writablePaths?: readonly string[]
  /** 执行器路径（测试注入）。 */
  readonly executable?: string
}

/**
 * 生成 seatbelt profile（纯函数，可测）。
 *
 * 立场：**默认拒绝**，只放行"能把命令跑起来"必需的东西。
 * - `file-read*` 放行：不读 /usr、/System、node 二进制就什么都跑不起来；读的隔离不在这一档的承诺里
 *   （我们承诺的是**写**隔离，见 host-local 的 features 声明 —— 不夸大能力）；
 * - `file-write*` 只给工作区与显式列出的可写路径；
 * - 网络默认拒绝（模型调用发生在宿主进程里，不受这里影响）。
 */
export function seatbeltProfile(options: SeatbeltOptions): string {
  // 默认**只有工作区可写**：多给一个路径就是多一个逃逸面，要由调用方显式开。
  // （实测教训：第一版默认把 /tmp 也算可写，模型立刻用它把文件写到了工作区之外。）
  const writable = [options.workspaceDir, ...(options.writablePaths ?? [])]
  const lines = [
    '(version 1)',
    '(deny default)',
    '; 跑起来必需：进程与基础只读系统访问',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    '; 写入只允许工作区与显式列出的路径',
    ...writable.map(path => '(allow file-write* (subpath "' + path + '"))'),
  ]
  if (options.allowNetwork === true) lines.push('(allow network*)')
  else lines.push('; 默认断网', '(deny network*)')
  return lines.join('\n')
}

/**
 * 本机 seatbelt 沙箱 provider（macOS）。
 *
 * 两项诚实声明：
 * 1. features 只有 **fs-write-isolation** 与 **network-deny** —— 没有 `fs-isolation`（读仍然全开）、
 *    没有 `resource-limits`、没有 `pid-isolation`。需要完整 fs 隔离的 recipe 在装配期就会失败，
 *    而不是"看起来有沙箱、其实只挡了写"；
 * 2. **不可用就拒绝执行**（fail-closed）：macOS 上没有 sandbox-exec 时抛 `SandboxUnavailableError`，
 *    绝不静默退回无隔离执行。
 */
export class SeatbeltSandbox implements SandboxProvider {
  readonly provider = 'seatbelt'
  readonly features: readonly SandboxFeature[] = ['fs-write-isolation', 'network-deny']
  private readonly options: SeatbeltOptions

  constructor(options: SeatbeltOptions) {
    // 坑（实测）：seatbelt 按**真实路径**匹配规则，而 macOS 的 /tmp 是 /private/tmp 的符号链接。
    // 不规范化的话，连"写工作区"都会被拒 —— 沙箱看起来坏了，其实是路径对不上。
    this.options = {
      ...options,
      workspaceDir: canonical(options.workspaceDir),
      ...(options.writablePaths === undefined
        ? {}
        : { writablePaths: options.writablePaths.map(canonical) }),
    }
  }

  /** 执行器是否可用（app 可以据此提前给出人话提示）。 */
  static available(executable: string = SANDBOX_EXEC_PATH): boolean {
    return existsSync(executable)
  }

  /** 不可用时抛错 —— 让调用方在**装配期**就失败。 */
  assertAvailable(): void {
    const executable = this.options.executable ?? SANDBOX_EXEC_PATH
    if (!existsSync(executable)) {
      throw new SandboxUnavailableError(
        'sandbox "seatbelt" is not available on this host (missing ' + executable + '); ' +
        'refusing to run commands without isolation - use --sandbox unconfined to opt out explicitly',
      )
    }
  }

  profile(): string {
    return seatbeltProfile(this.options)
  }

  /** 把一条命令包进沙箱（`sandbox-exec -p <profile> /bin/sh -c <command>`）。 */
  wrap(command: string): string {
    const executable = this.options.executable ?? SANDBOX_EXEC_PATH
    const profile = this.profile().replace(/'/g, "'\\''")
    const shellCommand = command.replace(/'/g, "'\\''")
    return "'" + executable + "' -p '" + profile + "' /bin/sh -c '" + shellCommand + "'"
  }

  /** 可写路径的**完整**清单（describe 与文档都照它说，不许含糊）。 */
  writablePaths(): readonly string[] {
    return [this.options.workspaceDir, ...(this.options.writablePaths ?? [])]
  }

  describe(): string {
    const scope = this.options.allowNetwork === true ? 'network allowed' : 'no network'
    return 'macOS seatbelt: writes allowed only under ' + this.writablePaths().join(', ') + '; ' + scope +
      '; reads are still open, and there are no CPU/memory/PID limits'
  }
}

export { SANDBOX_FEATURES }