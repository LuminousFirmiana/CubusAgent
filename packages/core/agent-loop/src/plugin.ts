import type { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import { SessionLogFile } from '@cubus/session'
import { echoTool } from './echo-tool.ts'
import { Loop } from './loop.ts'
import type { Tool } from './types.ts'

// 服务键声明合并：ctx.loop / ctx.sessionLog 由此获得类型。
declare module '@cubus/cordis' {
  interface Context {
    loop: Loop
    sessionLog: SessionLogFile
  }
}

export interface AgentLoopPluginConfig {
  /** 会话日志路径；默认 .cubus/session.jsonl（相对进程 cwd）。 */
  logPath?: string
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
 * - inject: ['llm'] —— llm 服务就绪后本插件才执行；llm 被换掉时自动重挂，
 *   循环因此总是拿着当前供应商的适配器；
 * - 所有 provide 都是 effect：卸载插件 = 服务消失、零残留。
 */
export const agentLoopPlugin = {
  name: 'agent-loop',
  inject: ['llm'],
  apply(ctx: Context, config: AgentLoopPluginConfig) {
    const log = new SessionLogFile(config.logPath ?? '.cubus/session.jsonl')
    ctx.provide('sessionLog', log)

    const adapter = ctx.get('llm') as LlmAdapter
    const loop = new Loop({
      log,
      adapter,
      tools: config.tools ?? [echoTool],
      // exactOptionalPropertyTypes：可选属性不能收到显式 undefined，只能整体缺省
      ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
      ...(config.generateId ? { generateId: config.generateId } : {}),
    })
    ctx.provide('loop', loop)
  },
}

