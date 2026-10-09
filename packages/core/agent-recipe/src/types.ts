import type { Context } from '@cubus/cordis'
import type { BudgetLimits, CapabilityKind } from '@cubus/session'
import type { CapabilityOffering } from './capabilities.ts'

/** 一项能力需求：kind 必填，features 做子集匹配，required 默认 true。 */
export interface CapabilityRequirement {
  readonly kind: CapabilityKind
  readonly features?: readonly string[]
  readonly required?: boolean
}

/**
 * 声明式产品契约（B4 起为必填；形状见 docs/design/recipe-capabilities.md §4）。
 *
 * 声明是数据：只放名字与引用。分支、拼装顺序与实现留在 mount()。
 * 必填子集 = contractVersion / requires / prompt / tools / permission：
 * 少任何一项，装配快照就无法完整记录产品面，因此装配期直接失败。
 */
export interface AgentRecipeManifest {
  /** manifest 契约版本；形状变更时递增。 */
  readonly contractVersion: 1
  readonly id: string
  readonly version: string
  readonly displayName: string
  readonly description?: string
  /** 能力需求；解析见 resolveCapabilities（缺必需能力即装配失败）。 */
  readonly requires: readonly CapabilityRequirement[]
  /** 静态基座提示词片段的稳定 id（必须由 mount 注册）。 */
  readonly prompt: { readonly fragmentId: string }
  /** 声明的工具名集合（必须与注册集合相等）。 */
  readonly tools: readonly string[]
  /** 默认审批档；app 可覆盖（优先级 app > manifest），最终值与来源进装配快照。 */
  readonly permission: { readonly profile: string }
  /** 默认预算上限（C5）：app 可覆盖或收紧；实际生效值进装配快照。 */
  readonly budget?: BudgetLimits
  /** 评测套件 id：这个产品按哪套评测计分（由评测包注册与校验）。 */
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
