/**
 * @cubus/agent-recipe 的**公开面**（P1）：Recipe 作者与 Host 作者只用这里的名字。
 *
 * 规则见 docs/design/versioning.md：
 * - 显式导出，不用 export *（新名字必须显式加进来）；
 * - 内部路径不是 API；
 * - 这里的改动同样是"公开面变更"：加可选字段是 additive，改名/删名/改语义要升 minor 并写迁移。
 *
 * packages/support/architecture-guard 会检查本文件不出现 export *。
 */
export type {
  AgentHost,
  AgentRecipe,
  AgentRecipeManifest,
  AgentSessionDescriptor,
  CapabilityRequirement,
  HostCapabilityOffering,
} from './types.ts'
export {
  CapabilityNegotiationError,
  RecipeDeclarationMismatchError,
  RecipeManifestError,
  resolveCapabilities,
  toMountedCapabilities,
  validateManifest,
  verifyDeclarations,
} from './capabilities.ts'
export type {
  ActualContributions,
  CapabilityOffering,
  CapabilityPins,
  CapabilityResolution,
  CapabilityResolutionInput,
  CapabilityNegotiationReason,
} from './capabilities.ts'
export {
  AssemblyMismatchError,
  assemblyIdentity,
  compareAssemblyIdentity,
  createMountSnapshot,
  MountSnapshotError,
} from './snapshot.ts'
export type { AssemblyIdentity, MountSnapshotInput } from './snapshot.ts'
export { createAgentRuntimePlugin } from './plugin.ts'
export type { AgentRuntimePluginConfig } from './plugin.ts'
