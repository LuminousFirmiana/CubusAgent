import { CAPABILITY_KINDS } from '@cubus/session'
import type { CapabilityKind, MountedCapability } from '@cubus/session'
import type { AgentRecipeManifest, CapabilityRequirement } from './types.ts'

/**
 * 能力协商（B2；设计见 docs/design/recipe-capabilities.md）：
 * Recipe 声明需求（CapabilityRequirement），Host 声明供给（CapabilityOffering），
 * 这里做纯函数匹配 —— 无 IO、无 ctx、无 provider 依赖，因此可单测、可落日志。
 */

/** Host 声明的一项可用能力：描述，不含实现（实现在装配时由 Host 挂载）。 */
export interface CapabilityOffering {
  readonly kind: CapabilityKind
  readonly provider: string
  readonly features: readonly string[]
}

/** app 级 pin：同 kind 有多个候选时用来消解歧义（不 pin 就失败，不静默挑一个）。 */
export type CapabilityPins = Readonly<Partial<Record<CapabilityKind, string>>>

export interface CapabilityResolution {
  /** 每种 kind 至多一项，按 kind 排序（确定性）。 */
  readonly selection: readonly CapabilityOffering[]
  /** 声明为可选、但没有候选的需求（必须进装配快照并告警）。 */
  readonly optionalMissing: readonly CapabilityRequirement[]
}

export interface CapabilityResolutionInput {
  readonly recipeId: string
  readonly requirements: readonly CapabilityRequirement[]
  readonly offerings: readonly CapabilityOffering[]
  readonly pins?: CapabilityPins
}

export type CapabilityNegotiationReason = 'missing' | 'ambiguous' | 'unknown-pin' | 'undeclared-host'

function describeRequirement(requirement: CapabilityRequirement): string {
  const features = requirement.features ?? []
  return requirement.kind + (features.length === 0 ? '' : '[' + features.join(',') + ']')
}

function describeOfferings(offerings: readonly CapabilityOffering[]): string {
  if (offerings.length === 0) return '(none)'
  return offerings
    .map(offering => offering.kind + ':' + offering.provider +
      (offering.features.length === 0 ? '' : '[' + offering.features.join(',') + ']'))
    .join(', ')
}

function describeList(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : '[' + values.join(', ') + ']'
}

function byKind(left: { kind: string }, right: { kind: string }): number {
  return left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0
}

/** 供给覆盖需求：kind 相同且需求 features 是供给 features 的子集。 */
function covers(offering: CapabilityOffering, requirement: CapabilityRequirement): boolean {
  if (offering.kind !== requirement.kind) return false
  for (const feature of requirement.features ?? []) {
    if (!offering.features.includes(feature)) return false
  }
  return true
}

function negotiationMessage(options: {
  recipeId: string
  reason: CapabilityNegotiationReason
  requirement?: CapabilityRequirement
  candidates: readonly CapabilityOffering[]
  available: readonly CapabilityOffering[]
}): string {
  const available = describeOfferings(options.available)
  if (options.reason === 'undeclared-host') {
    return 'recipe ' + options.recipeId +
      ' declares capability requirements but the host does not implement capabilities()'
  }
  const requirement = options.requirement
  if (requirement === undefined) {
    return 'recipe ' + options.recipeId + ' capability negotiation failed (' + options.reason +
      '); host offers: ' + available
  }
  const wanted = describeRequirement(requirement)
  if (options.reason === 'missing') {
    return 'recipe ' + options.recipeId + ' requires capability ' + wanted +
      ' but the host offers no matching capability; host offers: ' + available
  }
  if (options.reason === 'ambiguous') {
    const providers = options.candidates.map(candidate => candidate.kind + ':' + candidate.provider).join(', ')
    return 'recipe ' + options.recipeId + ' requires ' + wanted + ' and the host offers ' +
      String(options.candidates.length) + ' candidates (' + providers +
      '); pin one explicitly, e.g. { ' + requirement.kind + ": '<provider>' }"
  }
  return 'recipe ' + options.recipeId + ' pinned ' + requirement.kind +
    ' to a provider the host does not offer; candidates: ' + describeOfferings(options.candidates) +
    '; host offers: ' + available
}

/** 缺必需能力 / 需求歧义 / pin 指向不存在的 provider：装配期失败，不带半成品会话。 */
export class CapabilityNegotiationError extends Error {
  readonly recipeId: string
  readonly reason: CapabilityNegotiationReason
  readonly requirement: CapabilityRequirement | undefined
  readonly candidates: readonly CapabilityOffering[]
  readonly available: readonly CapabilityOffering[]

  constructor(options: {
    recipeId: string
    reason: CapabilityNegotiationReason
    requirement?: CapabilityRequirement
    candidates: readonly CapabilityOffering[]
    available: readonly CapabilityOffering[]
    message?: string
  }) {
    super(options.message ?? negotiationMessage(options))
    this.name = 'CapabilityNegotiationError'
    this.recipeId = options.recipeId
    this.reason = options.reason
    this.requirement = options.requirement
    this.candidates = options.candidates
    this.available = options.available
  }
}

/** manifest 自身不合法（契约版本、未知 kind、重复需求、空字符串等）。 */
export class RecipeManifestError extends Error {
  readonly recipeId: string

  constructor(recipeId: string, message: string) {
    super('recipe ' + (recipeId === '' ? '(empty id)' : recipeId) + ': ' + message)
    this.name = 'RecipeManifestError'
    this.recipeId = recipeId
  }
}

/** 声明与实现不符（片段 id 未注册、工具集合不等、评测套件未注册）。 */
export class RecipeDeclarationMismatchError extends Error {
  readonly recipeId: string

  constructor(recipeId: string, message: string) {
    super('recipe ' + recipeId + ': ' + message)
    this.name = 'RecipeDeclarationMismatchError'
    this.recipeId = recipeId
  }
}

function isCapabilityKind(value: string): value is CapabilityKind {
  return (CAPABILITY_KINDS as readonly string[]).includes(value)
}

/**
 * 校验 manifest 自身（B4 起所有 manifest 都是完整声明式契约）。
 * 类型系统已经保证字段存在；这里校验运行期可能损坏的内容
 * （JSON 来源、空字符串、未知 kind、重复项、契约版本）。
 */
export function validateManifest(manifest: AgentRecipeManifest): void {
  const id = manifest.id
  if (id.trim() === '') throw new RecipeManifestError(String(id), 'manifest.id must be a non-empty string')
  if (manifest.version.trim() === '') throw new RecipeManifestError(id, 'manifest.version must be a non-empty string')
  if (manifest.displayName.trim() === '') {
    throw new RecipeManifestError(id, 'manifest.displayName must be a non-empty string')
  }
  if ((manifest.contractVersion as number) !== 1) {
    throw new RecipeManifestError(id, 'unsupported manifest.contractVersion: ' + String(manifest.contractVersion))
  }
  if (manifest.prompt.fragmentId.trim() === '') {
    throw new RecipeManifestError(id, 'manifest.prompt.fragmentId must be a non-empty string')
  }
  if (manifest.permission.profile.trim() === '') {
    throw new RecipeManifestError(id, 'manifest.permission.profile must be a non-empty string')
  }

  const seen = new Set<string>()
  for (const requirement of manifest.requires) {
    if (!isCapabilityKind(requirement.kind)) {
      throw new RecipeManifestError(id, 'unknown capability kind: ' + String(requirement.kind))
    }
    if (seen.has(requirement.kind)) {
      throw new RecipeManifestError(id, 'duplicate capability requirement: ' + requirement.kind)
    }
    seen.add(requirement.kind)
    for (const feature of requirement.features ?? []) {
      if (feature.trim() === '') {
        throw new RecipeManifestError(id, 'empty feature name in requirement: ' + requirement.kind)
      }
    }
  }

  const tools = manifest.tools ?? []
  for (const tool of tools) {
    if (tool.trim() === '') throw new RecipeManifestError(id, 'manifest.tools contains an empty name')
  }
  if (new Set(tools).size !== tools.length) {
    throw new RecipeManifestError(id, 'manifest.tools contains duplicates')
  }

  if (manifest.prompt !== undefined && manifest.prompt.fragmentId.trim() === '') {
    throw new RecipeManifestError(id, 'manifest.prompt.fragmentId must be a non-empty string')
  }
  if (manifest.permission !== undefined && manifest.permission.profile.trim() === '') {
    throw new RecipeManifestError(id, 'manifest.permission.profile must be a non-empty string')
  }
  if (manifest.evaluation !== undefined && manifest.evaluation.suite.trim() === '') {
    throw new RecipeManifestError(id, 'manifest.evaluation.suite must be a non-empty string')
  }
  if (manifest.presentation !== undefined && manifest.presentation.label.trim() === '') {
    throw new RecipeManifestError(id, 'manifest.presentation.label must be a non-empty string')
  }

  if (manifest.budget !== undefined) {
    const limits = [
      ['maxSteps', manifest.budget.maxSteps],
      ['maxToolCalls', manifest.budget.maxToolCalls],
      ['maxDurationMs', manifest.budget.maxDurationMs],
    ] as const
    for (const [name, value] of limits) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw new RecipeManifestError(id, 'manifest.budget.' + name + ' must be a positive integer')
      }
    }
  }
}

/**
 * 需求 x 供给 -> 选中项 + 可选缺失项。
 * 缺必需能力、歧义、pin 未知都抛错；不静默选择、不在运行期降级。
 */
export function resolveCapabilities(input: CapabilityResolutionInput): CapabilityResolution {
  const pins = input.pins ?? {}
  const selection: CapabilityOffering[] = []
  const optionalMissing: CapabilityRequirement[] = []

  for (const requirement of input.requirements) {
    if (selection.some(chosen => chosen.kind === requirement.kind)) {
      throw new RecipeManifestError(input.recipeId, 'duplicate capability requirement: ' + requirement.kind)
    }
    const candidates = input.offerings.filter(offering => covers(offering, requirement))

    if (candidates.length === 0) {
      if (requirement.required === false) {
        optionalMissing.push(requirement)
        continue
      }
      throw new CapabilityNegotiationError({
        recipeId: input.recipeId,
        reason: 'missing',
        requirement,
        candidates,
        available: input.offerings,
      })
    }

    const pinned = pins[requirement.kind]
    if (pinned !== undefined) {
      const match = candidates.find(candidate => candidate.provider === pinned)
      if (match === undefined) {
        throw new CapabilityNegotiationError({
          recipeId: input.recipeId,
          reason: 'unknown-pin',
          requirement,
          candidates,
          available: input.offerings,
          message: 'recipe ' + input.recipeId + ' pinned ' + requirement.kind + ' to ' + JSON.stringify(pinned) +
            ' but no such offering exists; candidates: ' +
            describeOfferings(candidates) + '; host offers: ' + describeOfferings(input.offerings),
        })
      }
      selection.push(match)
      continue
    }

    const [first, second] = candidates
    if (first === undefined) continue
    if (second !== undefined) {
      throw new CapabilityNegotiationError({
        recipeId: input.recipeId,
        reason: 'ambiguous',
        requirement,
        candidates,
        available: input.offerings,
      })
    }
    selection.push(first)
  }

  selection.sort(byKind)
  optionalMissing.sort(byKind)
  return { selection, optionalMissing }
}

/** 装配后实际注册的贡献（用于 §5 的声明/实现校验）。 */
export interface ActualContributions {
  readonly promptFragmentIds: readonly string[]
  readonly toolNames: readonly string[]
  /** 评测运行时提供；无评测上下文时省略 = 不校验评测套件。 */
  readonly evaluationSuites?: readonly string[]
}

/**
 * 声明与实现必须对得上：片段 id 已注册、工具集合相等、评测套件已注册。
 * 这是"声明不退化成正释"的执行者，因此没有跳过选项。
 */
export function verifyDeclarations(manifest: AgentRecipeManifest, actual: ActualContributions): void {
  if (!actual.promptFragmentIds.includes(manifest.prompt.fragmentId)) {
    throw new RecipeDeclarationMismatchError(
      manifest.id,
      'declares prompt fragment ' + JSON.stringify(manifest.prompt.fragmentId) +
      ' but registered fragments are ' + describeList(actual.promptFragmentIds),
    )
  }

  const declared = new Set(manifest.tools)
  const registered = new Set(actual.toolNames)
  const missing = [...declared].filter(name => !registered.has(name)).sort()
  const undeclared = [...registered].filter(name => !declared.has(name)).sort()
  if (missing.length > 0 || undeclared.length > 0) {
    throw new RecipeDeclarationMismatchError(
      manifest.id,
      'tool declaration mismatch: declared but not registered ' + describeList(missing) +
      '; registered but not declared ' + describeList(undeclared),
    )
  }

  if (manifest.evaluation !== undefined && actual.evaluationSuites !== undefined &&
    !actual.evaluationSuites.includes(manifest.evaluation.suite)) {
    throw new RecipeDeclarationMismatchError(
      manifest.id,
      'declares evaluation suite ' + JSON.stringify(manifest.evaluation.suite) +
      ' but registered suites are ' + describeList(actual.evaluationSuites),
    )
  }
}

/** 协商结果 -> 装配快照里的能力清单（B3 写入 session/mount 事件）。 */
export function toMountedCapabilities(selection: readonly CapabilityOffering[]): MountedCapability[] {
  return [...selection]
    .sort(byKind)
    .map(offering => ({
      kind: offering.kind,
      provider: offering.provider,
      features: [...offering.features].sort(),
    }))
}
