import type { AgentHost } from '@cubus/agent-recipe'
import type { ToolApprovalService } from './service.ts'

/** Add an approval policy to an existing Host without changing its providers. */
export function withToolApprovalHost(host: AgentHost, approval: ToolApprovalService): AgentHost {
  return {
    // 能力声明原样透传：装饰器不改变 Host 能提供什么。
    ...(host.capabilities === undefined ? {} : { capabilities: () => host.capabilities!() }),
    async mount(ctx, session, selection) {
      await (selection === undefined
        ? host.mount(ctx, session)
        : host.mount(ctx, session, selection))
      ctx.provide('toolApproval', approval)
    },
  }
}
