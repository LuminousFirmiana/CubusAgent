import type { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import type { SessionLog } from '@cubus/session'
import type { SystemPromptService } from '@cubus/system-prompt'
import type { ToolRegistryService } from '@cubus/tool-registry'
import { echoTool } from './echo-tool.ts'
import { Loop } from './loop.ts'
import type { Tool } from './types.ts'

// 服务键声明合并：ctx.loop 由本插件提供；ctx.sessionLog 由 Host provider 提供。
declare module '@cubus/cordis' {
  interface Context {
    loop: Loop
    sessionLog: SessionLog
  }
}

export interface AgentLoopPluginConfig {
  /** 工具集；默认只有 echo。 */
  tools?: Tool[]
  /** 系统提示：随每次模型请求传出。 */
  systemPrompt?: string
  /** ID 生成器（测试注入实现确定性）；默认 randomUUID。 */
  generateId?: () => string
}

/**
 * 循环插件：把 S1.2 的朴素 Loop 挂成 cordis 插件。
 *
 * - inject: ['llm', 'sessionLog'] —— 模型与会话存储就绪后本插件才执行；
 *   任一服务被替换时自动重挂，循环因此总是绑定当前 Host provider；
 * - 所有 provide 都是 effect：卸载插件 = 服务消失、零残留。
 */
export const agentLoopPlugin = {
  name: 'agent-loop',
  inject: ['llm', 'sessionLog'],
  apply(ctx: Context, config: AgentLoopPluginConfig) {
    const adapter = ctx.get('llm') as LlmAdapter
    const loop = new Loop({
      log: ctx.sessionLog,
      adapter,
      tools: config.tools ?? [echoTool],
      resolveCapabilities: () => {
        const promptService = ctx.get('systemPrompt') as SystemPromptService | undefined
        const toolService = ctx.get('tools') as ToolRegistryService | undefined
        const assembledPrompt = promptService?.assemble()
        return {
          ...(promptService === undefined
            ? (config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt })
            : (assembledPrompt === undefined ? {} : { systemPrompt: assembledPrompt })),
          tools: toolService?.snapshot() ?? config.tools ?? [echoTool],
        }
      },
      // exactOptionalPropertyTypes：可选属性不能收到显式 undefined，只能整体缺省
      ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
      ...(config.generateId ? { generateId: config.generateId } : {}),
    })
    ctx.provide('loop', loop)
  },
}
