import type { AgentHost, HostCapabilityOffering } from '@cubus/agent-recipe'
import type { ToolApprovalService } from './service.ts'

/**
 * 装饰器不发明 Host 的能力：capabilities() 只追加这一项。
 * 策略档（ask/allow/deny）是声明/覆盖数据，不是能力特性，所以它不进 features。
 */
export interface ApprovalRulesFacts {
  /** 规则文件路径（工作区相对）。 */
  readonly path: string
  /** 规则条数。 */
  readonly count: number
  /** 规则内容的指纹：改了规则它就变 —— "当时生效的是哪一份"可追溯。 */
  readonly sha256: string
}

/**
 * 把审批策略作为 Host 的一项能力（B4）。
 *
 * `rules`（S5.1）只是**事实**：规则由 app 读进内存后交给审批服务执行，这里把"这次带了哪份规则"
 * 写进能力的 features，于是装配快照里能直接看到 —— 规则原文不进日志（它在仓库里，由版本控制管），
 * 日志记 path + 条数 + 指纹：内容一改指纹就变。
 */
export function withToolApprovalHost(
  host: AgentHost,
  approval: ToolApprovalService,
  rules?: ApprovalRulesFacts,
): AgentHost {
  const offering: HostCapabilityOffering = {
    kind: 'approval',
    provider: 'tool-approval',
    features: rules === undefined || rules.count === 0
      ? []
      : ['rules:' + String(rules.count), 'rules-path:' + rules.path, 'rules-sha256:' + rules.sha256.slice(0, 12)],
    mount(ctx) {
      ctx.provide('toolApproval', approval)
    },
  }

  return {
    capabilities: () => [...(host.capabilities?.() ?? []), offering],
    async mount(ctx, session, selection) {
      // 只把本装饰器不拥有的 offerings 转发给内层 Host：
      // 否则 approval 会被内层 Host 挂一次、这里再挂一次（重复注册同名服务）。
      const inner = host.capabilities?.() ?? []
      const innerSelection = selection?.filter(candidate => inner.includes(candidate))
      await (innerSelection === undefined
        ? host.mount(ctx, session)
        : host.mount(ctx, session, innerSelection))
      // 直接使用装饰器（不经过运行时协商）时也提供审批服务；
      // 协商路径下只有被选中才挂载。
      if (selection === undefined || selection.includes(offering)) {
        offering.mount(ctx, session)
      }
    },
  }
}