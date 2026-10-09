import { agentLoopPlugin } from '@cubus/agent-loop'
import type { AgentLoopPluginConfig } from '@cubus/agent-loop'
import { budgetPolicyPlugin } from '@cubus/budget'
import type { Context } from '@cubus/cordis'
import type { BudgetLimits } from '@cubus/session'
import { systemPromptPlugin } from '@cubus/system-prompt'
import type { SystemPromptService } from '@cubus/system-prompt'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import type { ToolRegistryService } from '@cubus/tool-registry'
import {
  CapabilityNegotiationError,
  resolveCapabilities,
  validateManifest,
  verifyDeclarations,
} from './capabilities.ts'
import type { ActualContributions, CapabilityPins } from './capabilities.ts'
import { createMountSnapshot, MountSnapshotError } from './snapshot.ts'
import type {
  AgentHost,
  AgentRecipe,
  AgentSessionDescriptor,
  CapabilityRequirement,
  HostCapabilityOffering,
} from './types.ts'

export interface AgentRuntimePluginConfig<RecipeOptions = void> {
  host: AgentHost
  recipe: AgentRecipe<RecipeOptions>
  recipeOptions: RecipeOptions
  session: AgentSessionDescriptor
  loop?: AgentLoopPluginConfig
  /** app 级 pin：同一 kind 有多个候选时消解歧义（不 pin 即装配失败）。 */
  capabilityPins?: CapabilityPins
  /** app 级审批档覆盖；优先级 app > manifest.permission。 */
  permissionProfile?: string
  /** app 级预算覆盖；优先级 app > manifest.budget。设置时挂载预算策略插件。 */
  budget?: BudgetLimits
}

/** 协商结果：选中的 offerings + 声明可选但缺失的能力。 */
interface DeclarativeAssembly {
  readonly selection: readonly HostCapabilityOffering[]
  readonly optionalMissing: readonly CapabilityRequirement[]
}

/**
 * 需求 x 供给协商：B4 起每个 recipe 都声明 requires，因此这是唯一路径。
 * 缺必需能力 / 歧义 / pin 未知 / Host 不支持声明，都在这里失败（装配期）。
 */
function negotiate(
  manifest: AgentRecipe['manifest'],
  host: AgentHost,
  pins: CapabilityPins | undefined,
): DeclarativeAssembly {
  const offerings = host.capabilities?.()
  if (offerings === undefined) {
    throw new CapabilityNegotiationError({
      recipeId: manifest.id,
      reason: 'undeclared-host',
      candidates: [],
      available: [],
    })
  }

  const resolution = resolveCapabilities({
    recipeId: manifest.id,
    requirements: manifest.requires,
    offerings,
    ...(pins === undefined ? {} : { pins }),
  })

  // 协商结果只带描述；回填 Host 的 offering 对象以保留装配动作。
  const selection = offerings.filter(offering =>
    resolution.selection.some(chosen =>
      chosen.kind === offering.kind && chosen.provider === offering.provider))

  return { selection, optionalMissing: resolution.optionalMissing }
}

/** 从已挂载的服务读出"实际注册了什么"，用于声明/实现校验。 */
function actualContributions(ctx: Context): ActualContributions {
  const promptService = ctx.get('systemPrompt') as SystemPromptService | undefined
  const toolService = ctx.get('tools') as ToolRegistryService | undefined
  return {
    promptFragmentIds: (promptService?.list() ?? []).map(fragment => fragment.id),
    toolNames: (toolService?.snapshot() ?? []).map(tool => tool.name),
  }
}

/**
 * One session composition root. Child fibers preserve the Host/Recipe boundary while
 * making the complete assembly reversible through one parent fiber.
 *
 * 装配顺序（B4 起唯一路径）：
 * 协商 -> 只挂选中 -> 挂 Recipe -> 挂 Loop -> 校验声明 -> 写装配快照。
 */
export function createAgentRuntimePlugin<RecipeOptions>(config: AgentRuntimePluginConfig<RecipeOptions>) {
  const manifest = config.recipe.manifest
  validateManifest(manifest)
  const recipeId = manifest.id
  const assembly = negotiate(manifest, config.host, config.capabilityPins)

  return {
    name: 'agent-runtime:' + recipeId,
    async apply(ctx: Context) {
      await ctx.plugin(systemPromptPlugin)
      await ctx.plugin(toolRegistryPlugin)
      await ctx.plugin({
        name: 'agent-host',
        apply(hostContext: Context) {
          return config.host.mount(hostContext, config.session, assembly.selection)
        },
      })
      await ctx.plugin({
        name: 'agent-recipe:' + recipeId,
        apply(recipeContext: Context) {
          return config.recipe.mount(recipeContext, config.recipeOptions)
        },
      })
      await ctx.plugin(agentLoopPlugin, config.loop ?? {})

      // 预算（C5）：只要有效上限里至少有一项，就挂策略插件；
      // 它观察日志事件并在超限时调用 loop.cancel()（走 S4.3b 的取消与结算）。
      const budget = config.budget ?? manifest.budget
      if (budget !== undefined) {
        await ctx.plugin(budgetPolicyPlugin, { limits: budget })
      }

      verifyDeclarations(manifest, actualContributions(ctx))

      const permission = config.permissionProfile === undefined
        ? { profile: manifest.permission.profile, source: 'manifest' as const }
        : { profile: config.permissionProfile, source: 'app' as const }

      const snapshot = createMountSnapshot({
        manifest,
        selection: assembly.selection,
        optionalMissing: assembly.optionalMissing,
        permission,
        ...(budget === undefined ? {} : { budget }),
        config: config.recipeOptions,
      })

      const log = ctx.get('sessionLog')
      if (log === undefined) {
        throw new MountSnapshotError(recipeId, 'cannot record session/mount: no session-log provider is mounted')
      }
      // 装配已全部成功；这条事件必须是日志第一条（此前没有任何写入者）。
      await log.append({ type: 'session/mount', mount: snapshot })
    },
  }
}
