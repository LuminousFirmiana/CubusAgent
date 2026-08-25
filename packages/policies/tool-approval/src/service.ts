import type { Context } from '@cubus/cordis'
import type { ToolExecutionContext } from '@cubus/tool-registry'

export interface ToolApprovalRequest {
  toolName: string
  args: unknown
}

export interface ToolApprovalDecision {
  outcome: 'allow' | 'deny'
  reason?: string
}

export interface ToolApprovalService {
  decide(
    request: ToolApprovalRequest,
    context: ToolExecutionContext,
  ): Promise<ToolApprovalDecision> | ToolApprovalDecision
}

declare module '@cubus/cordis' {
  interface Context {
    toolApproval: ToolApprovalService
  }
}

export function createStaticToolApproval(
  outcome: ToolApprovalDecision['outcome'],
  reason?: string,
): ToolApprovalService {
  return {
    decide() {
      return { outcome, ...(reason === undefined ? {} : { reason }) }
    },
  }
}

export function requireToolApproval(ctx: Context): ToolApprovalService {
  const approval = ctx.get('toolApproval')
  if (approval === undefined) throw new Error('Coding Agent requires a tool approval provider')
  return approval
}
