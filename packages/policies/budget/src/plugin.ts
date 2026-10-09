import type { Loop } from '@cubus/agent-loop'
import type { Context } from '@cubus/cordis'
import type { BudgetLimits, SessionEvent, SessionLog } from '@cubus/session'
import { BudgetPolicy } from './service.ts'

// 服务键声明合并（注意：必须显式导入被增强的模块，见交接文档坑 #22）。
// 本插件只依赖 loop 与 sessionLog 两项服务，因此显式声明它们，
// 不去依赖"别的包恰好加载过自己的声明合并"。
declare module '@cubus/cordis' {
  interface Context {
    loop: Loop
    sessionLog: SessionLog
    budget: BudgetPolicy
  }
}

export interface BudgetPolicyPluginConfig {
  /** 生效上限（app 覆盖 > manifest 默认，由运行时算好传进来）。 */
  limits: BudgetLimits
  /** 时长检查的轮询间隔；模型调用期间没有事件，靠它兜底。 */
  checkIntervalMs?: number
}

/**
 * 预算插件（C5）：把 BudgetPolicy 接到会话日志订阅与 loop.cancel() 上。
 *
 * - 只观察**已落盘**的事件（日志仍是唯一事实源）；
 * - 超限调用 loop.cancel()，走 S4.3b 的取消与结算语义，日志因此保持闭合；
 * - 不新增事件类型：超限原因通过 budget 服务状态暴露给 app（CLI 会打印）。
 */
export const budgetPolicyPlugin = {
  name: 'budget-policy',
  inject: ['sessionLog', 'loop'],
  apply(ctx: Context, config: BudgetPolicyPluginConfig) {
    const policy = new BudgetPolicy({
      limits: config.limits,
      onTrip: () => {
        ctx.loop.cancel()
      },
    })

    ctx.provide('budget', policy)

    ctx.effect(() => {
      const unsubscribe = ctx.sessionLog.subscribe?.((event: SessionEvent) => {
        policy.observe(event)
      })
      const intervalMs = config.checkIntervalMs ?? 1_000
      const timer = setInterval(() => {
        policy.check()
      }, intervalMs)
      // 不要因为预算计时器让进程无法退出（CLI / 测试都受益）。
      timer.unref?.()
      return () => {
        unsubscribe?.()
        clearInterval(timer)
      }
    })
  },
}
