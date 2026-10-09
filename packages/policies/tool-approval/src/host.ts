import type { AgentHost, HostCapabilityOffering } from '@cubus/agent-recipe'
import type { ToolApprovalService } from './service.ts'

/**
 * 把审批策略作为 Host 的一项能力（B4）。
 *
 * provider 名是 tool-approval；策略档（ask/allow/deny）是声明/覆盖数据，不是能力特性，
 * 因此 features 为空。装饰器不发明 Host 的能力：capabilities() 只追加这一项。
 */
export function withToolApprovalHost(host: AgentHost, approval: ToolApprovalService): AgentHost {
  const offering: HostCapabilityOffering = {
    kind: 'approval',
    provider: 'tool-approval',
    features: [],
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
