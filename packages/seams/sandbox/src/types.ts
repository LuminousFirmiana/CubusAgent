import { SANDBOX_FEATURES } from './features.ts'
import type { SandboxFeature } from './features.ts'

/**
 * 沙箱执行边界的 Service Definition（C2；设计见 docs/design/sandbox-seam.md）。
 *
 * 它是**描述与装配期契约**：能力协商用 features 判断"这个 Host 能不能满足我的隔离要求"，
 * 描述随装配快照落盘、并在 CLI 启动时如实打印。
 * 真正的强制（namespace/cgroup 等）由同一 Host 的 fs/subprocess provider 在边界内实现（C4）。
 */
export interface SandboxProvider {
  /** provider 名，进快照：'local-unconfined' | 'docker' | ... */
 readonly provider: string
  /** 声明本 provider 实际具备的边界特性；子集匹配用它判定能否满足需求。 */
  readonly features: readonly SandboxFeature[]
  /** 人类可读说明（CLI 启动时打印；无隔离必须说清）。 */
  describe(): string
}

/**
 * 本地 provider：**诚实声明自己无隔离**。
 *
 * 这是 C 阶段最重要的一条机制：`unconfined` 是显式特性，
 * 因此声明了 sandbox[fs-isolation] 的 recipe 在本地 Host 上会**装配期失败**，
 * 而不是"警告一下继续跑"。
 */
export class UnconfinedSandbox implements SandboxProvider {
  readonly provider = 'local-unconfined'
  readonly features: readonly SandboxFeature[] = ['unconfined']

  describe(): string {
    return 'no isolation: commands run directly on this host as the current user'
  }
}

/** features 是否包含全部需求（缺省空需求 = 任何 provider 都满足）。 */
export function satisfiesSandboxFeatures(
  features: readonly SandboxFeature[],
  required: readonly SandboxFeature[],
): boolean {
  return required.every(feature => features.includes(feature))
}

export { SANDBOX_FEATURES }
export type { SandboxFeature }
