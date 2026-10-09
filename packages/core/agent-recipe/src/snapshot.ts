import type { BudgetLimits, MountSnapshot } from '@cubus/session'
import { toMountedCapabilities } from './capabilities.ts'
import type { CapabilityOffering } from './capabilities.ts'
import type { AgentRecipeManifest, CapabilityRequirement } from './types.ts'

/**
 * 装配快照的构造与校验（B3；设计见 docs/design/recipe-capabilities.md §8）。
 * 快照会作为会话日志第一条事件落盘，因此这里做两道保证：
 * 1. config 必须是纯 JSON 值（provider 是类实例，不允许进 config）；
 * 2. 能力清单排序确定（同一装配永远产出同一份快照）。
 */

/** 装配快照不合法：config 不可序列化，或缺少记录快照所需的 provider。 */
export class MountSnapshotError extends Error {
  readonly recipeId: string

  constructor(recipeId: string, message: string) {
    super('recipe ' + recipeId + ': ' + message)
    this.name = 'MountSnapshotError'
    this.recipeId = recipeId
  }
}

/**
 * 校验纯 JSON 值：拒绝函数、symbol、undefined 值、类实例（含 provider）。
 * 与工具参数同规则 —— 进日志的东西必须能被 JSON 往返。
 */
export function assertJsonConfig(value: unknown, path = 'config'): void {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(path + ' must be a finite number')
    return
  }
  if (type === 'undefined') throw new TypeError(path + ' must not be undefined')
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new TypeError(path + ' must be a JSON value, got ' + type)
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertJsonConfig(item, path + '[' + String(index) + ']')
    }
    return
  }
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      path + ' must be a plain object (class instances such as providers are not allowed)',
    )
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertJsonConfig(item, path + '.' + key)
  }
}

export interface MountSnapshotInput {
  readonly manifest: AgentRecipeManifest
  readonly selection: readonly CapabilityOffering[]
  readonly optionalMissing: readonly CapabilityRequirement[]
  readonly permission: { readonly profile: string; readonly source: 'manifest' | 'app' }
  /** 实际生效的预算上限（C5）：只在设置时记录。 */
  readonly budget?: BudgetLimits
  readonly config: unknown
}

/** 构造装配快照；config 非纯 JSON 值时抛 MountSnapshotError。 */
export function createMountSnapshot(input: MountSnapshotInput): MountSnapshot {
  const recipeId = input.manifest.id
  // 无配置的 recipe（Options = void）记为 null：JSON 里不能有 undefined。
  const config = input.config === undefined ? null : input.config
  try {
    assertJsonConfig(config)
  } catch (error) {
    throw new MountSnapshotError(recipeId, 'config is not JSON-serializable: ' + (error as Error).message)
  }

  return {
    recipe: {
      id: recipeId,
      version: input.manifest.version,
      contractVersion: input.manifest.contractVersion ?? 0,
    },
    capabilities: toMountedCapabilities(input.selection),
    optionalMissing: input.optionalMissing.map(requirement => requirement.kind).sort(),
    permission: { profile: input.permission.profile, source: input.permission.source },
    ...(input.budget === undefined ? {} : { budget: input.budget }),
    config,
  }
}
