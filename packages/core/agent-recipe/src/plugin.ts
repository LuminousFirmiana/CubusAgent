import { agentLoopPlugin } from '@cubus/agent-loop'
import type { AgentLoopPluginConfig } from '@cubus/agent-loop'
import type { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import type {
  AgentHost,
  AgentRecipe,
  AgentRecipeManifest,
  AgentSessionDescriptor,
} from './types.ts'

export interface AgentRuntimePluginConfig<RecipeOptions = void> {
  host: AgentHost
  recipe: AgentRecipe<RecipeOptions>
  recipeOptions: RecipeOptions
  session: AgentSessionDescriptor
  loop?: AgentLoopPluginConfig
}

function validateManifest(manifest: AgentRecipeManifest): void {
  const fields = [
    ['id', manifest.id],
    ['version', manifest.version],
    ['displayName', manifest.displayName],
  ] as const
  for (const [name, value] of fields) {
    if (value.trim() === '') throw new TypeError(`agent recipe manifest ${name} must not be empty`)
  }
}

/**
 * One session composition root. Child fibers preserve the Host/Recipe boundary while
 * making the complete assembly reversible through one parent fiber.
 */
export function createAgentRuntimePlugin<RecipeOptions>(config: AgentRuntimePluginConfig<RecipeOptions>) {
  validateManifest(config.recipe.manifest)
  const recipeId = config.recipe.manifest.id

  return {
    name: `agent-runtime:${recipeId}`,
    async apply(ctx: Context) {
      await ctx.plugin(systemPromptPlugin)
      await ctx.plugin(toolRegistryPlugin)
      await ctx.plugin({
        name: 'agent-host',
        apply(hostContext: Context) {
          return config.host.mount(hostContext, config.session)
        },
      })
      await ctx.plugin({
        name: `agent-recipe:${recipeId}`,
        apply(recipeContext: Context) {
          return config.recipe.mount(recipeContext, config.recipeOptions)
        },
      })
      await ctx.plugin(agentLoopPlugin, config.loop ?? {})
    },
  }
}
