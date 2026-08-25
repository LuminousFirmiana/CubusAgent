import type { Tool } from '@cubus/tool-registry'
import type { ToolApprovalService } from './service.ts'

export class ToolApprovalDeniedError extends Error {
  constructor(toolName: string, reason?: string) {
    super(`tool denied by approval policy: ${toolName}${reason === undefined ? '' : ` (${reason})`}`)
    this.name = 'ToolApprovalDeniedError'
  }
}

export class ApprovedToolExecutionError extends Error {
  constructor(toolName: string, cause: unknown) {
    super(`tool approved but execution failed: ${toolName} (${cause instanceof Error ? cause.message : String(cause)})`)
    this.name = 'ApprovedToolExecutionError'
  }
}

/** Preserve the advertised schema while placing approval immediately around the side effect. */
export function withToolApproval(tool: Tool, approval: ToolApprovalService): Tool {
  return {
    ...tool,
    async execute(args, context) {
      context.signal.throwIfAborted()
      const decision = await approval.decide({ toolName: tool.name, args }, context)
      context.signal.throwIfAborted()
      if (decision.outcome === 'deny') {
        throw new ToolApprovalDeniedError(tool.name, decision.reason)
      }
      if (decision.outcome !== 'allow') {
        throw new TypeError(`invalid tool approval outcome: ${String(decision.outcome)}`)
      }
      try {
        return await tool.execute(args, context)
      } catch (error) {
        context.signal.throwIfAborted()
        throw new ApprovedToolExecutionError(tool.name, error)
      }
    },
  }
}
