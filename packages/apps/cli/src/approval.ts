import { createInterface } from 'node:readline/promises'
import type { Readable, Writable } from 'node:stream'
import type { ToolApprovalRequest, ToolApprovalService } from '@cubus/tool-approval'
import { createStaticToolApproval } from '@cubus/tool-approval'

export type CliApprovalMode = 'ask' | 'allow' | 'deny'

export interface ToolApprovalPrompter {
  readonly interactive: boolean
  confirm(request: ToolApprovalRequest, signal: AbortSignal): Promise<boolean>
}

export function createCliToolApproval(
  mode: CliApprovalMode,
  prompter?: ToolApprovalPrompter,
): ToolApprovalService {
  if (mode === 'allow') return createStaticToolApproval('allow', 'CLI allow mode')
  if (mode === 'deny') return createStaticToolApproval('deny', 'CLI deny mode')
  return {
    async decide(request, context) {
      if (prompter === undefined || !prompter.interactive) {
        return { outcome: 'deny', reason: 'interactive approval unavailable' }
      }
      const allowed = await prompter.confirm(request, context.signal)
      return allowed
        ? { outcome: 'allow', reason: 'approved interactively' }
        : { outcome: 'deny', reason: 'denied interactively' }
    },
  }
}

export function createTerminalApprovalPrompter(
  input: Readable & { isTTY?: boolean } = process.stdin,
  output: Writable = process.stderr,
): ToolApprovalPrompter {
  return {
    interactive: input.isTTY === true,
    async confirm(request, signal) {
      if (input.isTTY !== true) return false
      const readline = createInterface({ input, output })
      try {
        const args = JSON.stringify(request.args)
        const answer = await readline.question(
          `Approve tool ${request.toolName} with args ${args}? [y/N] `,
          { signal },
        )
        return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
      } finally {
        readline.close()
      }
    },
  }
}
