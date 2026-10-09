import { mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { GitChangeReport } from '@cubus/git'
import { GitCliWorkspaceProvider } from '@cubus/git-cli'
import { createLocalAgentHost } from '@cubus/host-local'
import type { LlmAdapter } from '@cubus/llm'
import { codingAgentRecipe } from '@cubus/recipe-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import type { SessionEvent } from '@cubus/session'
import { withToolApprovalHost } from '@cubus/tool-approval'
import { LocalFs, LocalSubprocess } from '@cubus/tools'
import { createCliToolApproval } from './approval.ts'
import type { CliApprovalMode, ToolApprovalPrompter } from './approval.ts'
import { resolveCliPath } from './config.ts'
import { createLiveRenderer } from './live.ts'

export interface CodingCommandOptions {
  workspace: string
  task: string
  trustWorkspace: boolean
  sessionsDir?: string
  approval?: CliApprovalMode
  maxModelAttempts?: number
}

export interface CodingCommandDependencies {
  adapterFactory?: () => LlmAdapter
  /** 提供时以实时事件流渲染运行过程；不提供则只在结束后汇总（既有行为）。 */
  output?: CodingCommandOutput
  /** Used by the real CLI to load credentials only after workspace trust is validated. */
  prepareAdapterFactory?: () => Promise<() => LlmAdapter>
  cwd?: string
  generateId?: () => string
  approvalPrompter?: ToolApprovalPrompter
  signal?: AbortSignal
}

export interface CodingCommandResult {
  sessionId: string
  logPath: string
  cancelled: boolean
  assistantText?: string
  turnEvents: SessionEvent[]
  /** 相对运行前基线的 Git 变更报告（只读；非 Git 目录以 isRepository: false 表达）。 */
  changes: GitChangeReport
}

export interface CodingCommandOutput {
  write(line: string): void
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export interface ParsedCodingCommand {
  help: boolean
  options?: CodingCommandOptions
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new CliUsageError(`${option} requires a value`)
  }
  return value
}

export function parseCodingCommand(args: readonly string[]): ParsedCodingCommand {
  let workspace: string | undefined
  let task: string | undefined
  let sessionsDir: string | undefined
  let approval: CliApprovalMode = 'ask'
  let maxModelAttempts = 3
  let trustWorkspace = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--trust-workspace') {
      trustWorkspace = true
      continue
    }
    if (arg === '--workspace') {
      workspace = optionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg === '--task') {
      task = optionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg === '--sessions-dir') {
      sessionsDir = optionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg === '--approval') {
      const value = optionValue(args, index, arg)
      if (value !== 'ask' && value !== 'allow' && value !== 'deny') {
        throw new CliUsageError('--approval must be ask, allow, or deny')
      }
      approval = value
      index += 1
      continue
    }
    if (arg === '--max-model-attempts') {
      const value = optionValue(args, index, arg)
      maxModelAttempts = Number(value)
      if (!Number.isInteger(maxModelAttempts) || maxModelAttempts < 1 || maxModelAttempts > 10) {
        throw new CliUsageError('--max-model-attempts must be an integer from 1 to 10')
      }
      index += 1
      continue
    }
    throw new CliUsageError(`unknown option: ${String(arg)}`)
  }

  if (workspace === undefined || workspace.trim() === '') {
    throw new CliUsageError('coding requires --workspace')
  }
  if (task === undefined || task.trim() === '') {
    throw new CliUsageError('coding requires --task')
  }
  return {
    help: false,
    options: {
      workspace,
      task,
      trustWorkspace,
      approval,
      maxModelAttempts,
      ...(sessionsDir === undefined ? {} : { sessionsDir }),
    },
  }
}

async function trustedWorkspace(path: string, cwd: string, trustWorkspace: boolean): Promise<string> {
  if (!trustWorkspace) {
    throw new CliUsageError(
      'refusing to run tools without --trust-workspace; local bash is not sandboxed',
    )
  }
  const resolved = resolveCliPath(path, cwd)
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CliUsageError(`workspace does not exist: ${resolved}`)
    }
    throw error
  }
  if (!info.isDirectory()) throw new CliUsageError(`workspace is not a directory: ${resolved}`)
  return realpath(resolved)
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export async function runCodingCommand(
  options: CodingCommandOptions,
  dependencies: CodingCommandDependencies,
): Promise<CodingCommandResult> {
  dependencies.signal?.throwIfAborted()
  const cwd = dependencies.cwd ?? process.cwd()
  // Trust is checked before adapterFactory, filesystem tools, or subprocess providers exist.
  const workspace = await trustedWorkspace(options.workspace, cwd, options.trustWorkspace)
  const requestedSessionsDir = resolveCliPath(
    options.sessionsDir ?? join(homedir(), '.cubus', 'sessions'),
    cwd,
  )
  await mkdir(requestedSessionsDir, { recursive: true })
  const sessionsDir = await realpath(requestedSessionsDir)
  if (isWithin(workspace, sessionsDir)) {
    throw new CliUsageError('sessions directory must be outside the tool-writable workspace')
  }
  // 只读 Git 检查走独立 provider，不把 Git 语义写进 Loop。
  // 基线在运行前记录，因此不要求工作区干净：用户原有改动留在 preexisting 一侧。
  const git = new GitCliWorkspaceProvider(new LocalSubprocess())
  const baseline = await git.baseline(workspace)

  const adapterFactory = dependencies.prepareAdapterFactory === undefined
    ? dependencies.adapterFactory
    : await dependencies.prepareAdapterFactory()
  dependencies.signal?.throwIfAborted()
  if (adapterFactory === undefined) throw new Error('adapter factory is required')
  const approval = createCliToolApproval(options.approval ?? 'ask', dependencies.approvalPrompter)

  const runtime = new SessionRuntime({
    rootDir: sessionsDir,
    host: withToolApprovalHost(createLocalAgentHost({ adapterFactory }), approval),
    recipe: codingAgentRecipe,
    recipeOptions: {
      fs: new LocalFs(workspace),
      subprocess: new LocalSubprocess(),
      workspaceDir: workspace,
    },
    ...(dependencies.generateId === undefined ? {} : { generateId: dependencies.generateId }),
  })
  const session = await runtime.create()
  dependencies.signal?.throwIfAborted()
  // 实时渲染：订阅会话日志的落盘事件（不引入第二个状态源）。
  const renderer = dependencies.output === undefined ? undefined : createLiveRenderer(dependencies.output)
  const unsubscribe = renderer === undefined
    ? undefined
    : runtime.subscribe(session.id, event => {
        renderer.onEvent(event)
      })
  let cancelled = false
  const cancel = (): void => {
    cancelled = true
    runtime.cancel(session.id)
  }
  dependencies.signal?.addEventListener('abort', cancel, { once: true })
  let run: Awaited<ReturnType<SessionRuntime['run']>>
  try {
    run = await runtime.run(session.id, options.task)
  } finally {
    dependencies.signal?.removeEventListener('abort', cancel)
    if (unsubscribe !== undefined) unsubscribe()
    renderer?.flush()
  }

  // 报告在结束或取消后都必须产出，因此不参与运行期取消。
  const changes = await git.report(workspace, baseline)

  return {
    sessionId: session.id,
    logPath: session.logPath,
    cancelled,
    ...(run.assistantText === undefined ? {} : { assistantText: run.assistantText }),
    turnEvents: run.turnEvents,
    changes,
  }
}

export function renderCodingResult(result: CodingCommandResult, output: CodingCommandOutput): void {
  output.write(`session: ${result.sessionId}`)
  output.write(`log: ${result.logPath}`)
  for (const event of result.turnEvents) {
    if (event.type !== 'tool/result') continue
    const firstLine = event.output.text.split('\n')[0] ?? ''
    output.write(`tool ${event.id}: ${event.ok ? 'ok' : 'failed'}${firstLine ? ` - ${firstLine}` : ''}`)
  }
  // 摘要文本由 Git provider 拥有，CLI 只负责逐行输出（不拼接 Git 语义）。
  for (const line of result.changes.summary.split('\n')) output.write(line)
  if (result.cancelled) output.write('status: cancelled')
  else output.write(`assistant: ${result.assistantText ?? ''}`)
}

export const CODING_COMMAND_HELP = `Usage:
  pnpm run cubus -- coding --workspace <path> --task <text> --trust-workspace [--approval ask|allow|deny] [--max-model-attempts 1..10] [--sessions-dir <path>]

Safety:
  --trust-workspace is required. Approval defaults to ask. Local bash is not sandboxed.`
