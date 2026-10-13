import type { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import { ContextCompactionPolicy } from './policy.ts'
import type { ContextCompactionOptions } from './policy.ts'

declare module '@cubus/cordis' {
  interface Context {
    /** 上下文压缩策略：由循环的 beforeRequest 钩子调用（见 agent-recipe 的晚绑定）。 */
    contextCompaction: ContextCompactionPolicy
  }
}

export type ContextCompactionPluginConfig = Omit<ContextCompactionOptions, 'log' | 'adapter'>

/**
 * 压缩策略插件：把策略挂成 cordis 服务（`ctx.contextCompaction`）。
 *
 * 它**不订阅日志、不改循环**：运行时把循环的 `beforeRequest` 钩子晚绑定到这个服务上
 * （字符串查找，内核因此不依赖任何策略包）。卸载插件 = 服务消失，循环回到"没有压缩"的行为。
 */
export const contextCompactionPlugin = {
  name: 'context-compaction',
  inject: ['llm', 'sessionLog'],
  apply(ctx: Context, config: ContextCompactionPluginConfig) {
    const policy = new ContextCompactionPolicy({
      log: ctx.sessionLog,
      adapter: ctx.get('llm') as LlmAdapter,
      ...config,
    })
    ctx.provide('contextCompaction', policy)
  },
}
