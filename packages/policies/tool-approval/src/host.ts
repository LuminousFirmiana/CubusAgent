import type { AgentHost } from '@cubus/agent-recipe'
import type { ToolApprovalService } from './service.ts'

/** Add an approval policy to an existing Host without changing its providers. */
export function withToolApprovalHost(host: AgentHost, approval: ToolApprovalService): AgentHost {
  return {
    async mount(ctx, session) {
      await host.mount(ctx, session)
      ctx.provide('toolApproval', approval)
    },
  }
}
