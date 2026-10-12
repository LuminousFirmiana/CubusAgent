import type { Context } from '@cubus/cordis'
import { ToolRegistryService } from './service.ts'
import type { ToolRegistrationOptions } from './service.ts'
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

/**
 * Build one lifecycle-owned tool contribution plugin.
 *
 * `options.source` 标记"这个工具来自哪个动态来源"（例如 'mcp'）；缺省 = 产品自带的内建工具，
 * 必须写进 manifest.tools。带来源的工具只需产品在 manifest.toolSources 里申报来源。
 */
export function toolContribution(tool: Tool, options: ToolRegistrationOptions = {}) {
  return {
    name: `tool:${tool.name}`,
    inject: ['tools'],
    apply(ctx: Context) {
      return ctx.tools.register(tool, options)
    },
  }
}
