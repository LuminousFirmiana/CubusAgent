import type { Context } from '@cubus/cordis'
import type { CapabilityKind } from '@cubus/session'
import type { CapabilityOffering } from './capabilities.ts'

/** 一项能力需求：kind 必填，features 做子集匹配，required 默认 true。 */
export interface CapabilityRequirement {
  readonly kind: CapabilityKind
  readonly features?: readonly string[]
  readonly required?: boolean
}

/**
 * 声明式产品契约（B2 起；形状见 docs/design/recipe-capabilities.md §4）。
 *
 * 声明是数据：只放名字与引用。分支、拼装顺序与实现留在 mount()。
 * 过渡规则：声明字段整体缺省 = legacy 装配（不协商、不校验），
 * B4 迁移三个 recipe 后这些字段转为必填并删除 legacy 路径。
 */
export interface AgentRecipeManifest {
  readonly id: string
  readonly version: string
  readonly displayName: string

  /** manifest 契约版本；出现任一声明字段时必须为 1。 */
  readonly contractVersion?: 1
  readonly description?: string
  /** 能力需求；解析见 resolveCapabilities。 */
  readonly requires?: readonly CapabilityRequirement[]
  /** 静态基座提示词片段的稳定 id（必须由 mount 注册）。 */
  readonly prompt?: { readonly fragmentId: string }
  /** 声明的工具名集合（必须与注册集合相等）。 */
  readonly tools?: readonly string[]
  /** 默认审批档；app 可覆盖（优先级 app > manifest）。 */
  readonly permission?: { readonly profile: string }
  /** 评测套件 id（由评测包注册）。 */
  readonly evaluation?: { readonly suite: string }
  /** 呈现意图，供 CLI/工作台消费。 */
  readonly presentation?: {
    readonly label: string
    readonly description?: string
    readonly icon?: string
  }
}

/** Product behavior. Credentials and deployment resources belong to the Host. */
export interface AgentRecipe<Options = void> {
  readonly manifest: AgentRecipeManifest
  mount(ctx: Context, options: Options): Promise<void> | void
}

/** Immutable per-session information available while mounting environment providers. */
export interface AgentSessionDescriptor {
  readonly id: string
  readonly directory: string
  readonly logPath: string
}

/**
 * Host 声明的一项能力：描述（kind/provider/features）+ 装配动作。
 * 装配动作只在该 offering 被协商选中时执行。
 */
export interface HostCapabilityOffering extends CapabilityOffering {
  mount(ctx: Context, session: AgentSessionDescriptor): Promise<void> | void
}

/** Environment providers. The Host does not choose prompt or product tools. */
export interface AgentHost {
  /**
   * 声明本 Host 能提供的能力（B3 起）。
   * 缺省 = 本 Host 不支持声明式协商；此时声明了 requires 的 recipe 会在装配期失败。
   */
  capabilities?(): readonly HostCapabilityOffering[]
  /**
   * 挂载环境 provider。
   * - 声明式装配（recipe 有 requires）：selection 是协商选中的 offerings，只挂这些；
   * - legacy 装配（recipe 无声明）：不给 selection，Host 按自己的默认行为挂载。
   */
  mount(
    ctx: Context,
    session: AgentSessionDescriptor,
    selection?: readonly HostCapabilityOffering[],
  ): Promise<void> | void
}
