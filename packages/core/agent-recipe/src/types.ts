import type { Context } from '@cubus/cordis'

export interface AgentRecipeManifest {
  readonly id: string
  readonly version: string
  readonly displayName: string
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

/** Environment providers. The Host does not choose prompt or product tools. */
export interface AgentHost {
  mount(ctx: Context, session: AgentSessionDescriptor): Promise<void> | void
}
