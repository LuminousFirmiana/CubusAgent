import type { Context } from '@cubus/cordis'
import { ToolRegistryService } from './service.ts'
import type { Tool } from './types.ts'

declare module '@cubus/cordis' {
  interface Context {
    tools: ToolRegistryService
  }
}

/** Service Definition provider. Product plugins contribute concrete tools. */
export const toolRegistryPlugin = {
  name: 'tool-registry',
  apply(ctx: Context) {
    ctx.provide('tools', new ToolRegistryService())
  },
}

/** Build one lifecycle-owned tool contribution plugin. */
export function toolContribution(tool: Tool) {
  return {
    name: `tool:${tool.name}`,
    inject: ['tools'],
    apply(ctx: Context) {
      return ctx.tools.register(tool)
    },
  }
}
