import type { Context } from '@cubus/cordis'
import { SystemPromptService } from './service.ts'
import type { SystemPromptFragment } from './service.ts'

declare module '@cubus/cordis' {
  interface Context {
    systemPrompt: SystemPromptService
  }
}

/** Service Definition provider. Product plugins contribute fragments to it. */
export const systemPromptPlugin = {
  name: 'system-prompt',
  apply(ctx: Context) {
    ctx.provide('systemPrompt', new SystemPromptService())
  },
}

/** Build one lifecycle-owned prompt contribution plugin. */
export function systemPromptContribution(fragment: SystemPromptFragment) {
  return {
    name: `system-prompt:${fragment.id}`,
    inject: ['systemPrompt'],
    apply(ctx: Context) {
      return ctx.systemPrompt.register(fragment)
    },
  }
}
