import { mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { BudgetState } from '@cubus/budget'
import type { CredentialsProvider } from '@cubus/credentials'
import type { GitChangeReport } from '@cubus/git'
import type { BudgetLimits, MountSnapshot } from '@cubus/session'
import { GitCliWorkspaceProvider } from '@cubus/git-cli'
import { createLocalAgentHost } from '@cubus/host-local'
import type { LlmAdapter } from '@cubus/llm'
import { cubusCodingAgentRecipe } from '@cubus/recipe-cubus-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import type { SessionEvent } from '@cubus/session'
import { withToolApprovalHost } from '@cubus/tool-approval'
import { LocalSubprocess } from '@cubus/tools'
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
  /** 预算覆盖（C5/D3b）：与 manifest 默认逐字段合并，app 优先。 */
  maxSteps?: number
  maxToolCalls?: number
  maxDurationMs?: number
  maxTokens?: number
}

export interface CodingCommandDependencies {
  adapterFactory?: () => LlmAdapter
  /** 提供时以实时事件流渲染运行过程；不提供则只在结束后汇总（既有行为）。 */
  output?: CodingCommandOutput
  /** app 提供的凭据来源（可选）：进 Host 的 credentials 能力，只有名字进快照。 */
  credentials?: CredentialsProvider
  /** Used by the real CLI to load credentials only after workspace trust is validated. */
  prepareAdapterFactory?: () => Promise<() => LlmAdapter>
  cwd?: string
  generateId?: () => string
  approvalPrompter?: ToolApprovalPrompter
  signal?: AbortSignal
}

/**
 * 由装配快照推导的沙箱提示（设计文档 §2 决定 7：无隔离必须说清）。
 * CLI 在**运行前**打印它，让使用者在模型动手之前就知道这次有没有边界。
 */
export function describeSandbox(mount: MountSnapshot | undefined): string {
  const sandbox = mount?.capabilities.find(capability => capability.kind === 'sandbox')
  if (sandbox === undefined) {
    return 'sandbox: unknown — no sandbox capability was recorded for this run'
  }
  if (sandbox.features.includes('fs-isolation')) {
    return 'sandbox: ' + sandbox.provider + ' [' + sandbox.features.join(', ') + ']'
  }
  return 'sandbox: ' + sandbox.provider + ' — NO ISOLATION: commands run on this host as the current user'
}

/** 预算用量的可读摘要（CLI 渲染用）。 */
export function describeBudget(state: BudgetState, limits: BudgetLimits | undefined): string {
  const limit = (value: number | undefined): string => (value === undefined ? '-' : String(value))
  return 'budget: ' + String(state.steps) + '/' + limit(limits?.maxSteps) + ' steps, ' +
    String(state.toolCalls) + '/' + limit(limits?.maxToolCalls) + ' tool calls, ' +
    String(state.tokens) + '/' + limit(limits?.maxTokens) + ' tokens, ' +
    (state.elapsedMs / 1000).toFixed(1) + 's/' +
    (limits?.maxDurationMs === undefined ? '-' : String(limits.maxDurationMs / 1000) + 's') +
    (state.tripped === undefined ? '' : ' (tripped: ' + state.tripped + ')')
}

export interface CodingCommandResult {
  sessionId: string
  logPath: string
  cancelled: boolean
  /** 本次运行实际生效的预算上限与用量（未配置时为 undefined）。 */
  budget?: { limits: BudgetLimits, state: BudgetState }
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
  // 默认档由 recipe manifest 声明（B4）；只有显式给了 --approval 才记作 app 覆盖。
  let approval: CliApprovalMode | undefined
  let maxModelAttempts = 3
  let maxSteps: number | undefined
  let maxToolCalls: number | undefined
  let maxDurationMs: number | undefined
  let maxTokens: number | undefined
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
    if (arg === '--max-steps' || arg === '--max-tool-calls' || arg === '--max-duration' || arg === '--max-tokens') {
      const value = optionValue(args, index, arg)
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new CliUsageError(arg + ' must be a positive integer')
      }
      if (arg === '--max-steps') maxSteps = parsed
      if (arg === '--max-tool-calls') maxToolCalls = parsed
      if (arg === '--max-duration') maxDurationMs = parsed * 1000
      if (arg === '--max-tokens') maxTokens = parsed
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
      ...(approval === undefined ? {} : { approval }),
      maxModelAttempts,
      ...(maxSteps === undefined ? {} : { maxSteps }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
      ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
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
  // 有效审批档：app 覆盖 > manifest 默认；最终值与来源会进装配快照。
  const approvalProfile = options.approval ?? cubusCodingAgentRecipe.manifest.permission.profile
  if (approvalProfile !== 'ask' && approvalProfile !== 'allow' && approvalProfile !== 'deny') {
    throw new CliUsageError('unsupported approval profile: ' + approvalProfile)
  }
  const approval = createCliToolApproval(approvalProfile, dependencies.approvalPrompter)
  // 有效预算：manifest 默认与 app 覆盖逐字段合并（app 优先）；两者都没有则不挂预算插件。
  const appBudget: BudgetLimits = {
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
    ...(options.maxDurationMs === undefined ? {} : { maxDurationMs: options.maxDurationMs }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  }
  const mergedBudget: BudgetLimits = { ...cubusCodingAgentRecipe.manifest.budget, ...appBudget }
  const budget = Object.keys(mergedBudget).length === 0 ? undefined : mergedBudget

  const runtime = new SessionRuntime({
    rootDir: sessionsDir,
    // 环境能力（模型、日志、文件系统、子进程）全部由 Host 提供；CLI 只给部署参数。
    host: withToolApprovalHost(
      createLocalAgentHost({
        adapterFactory,
        workspaceDir: workspace,
        ...(dependencies.credentials === undefined ? {} : { credentials: dependencies.credentials }),
      }),
      approval,
    ),
    recipe: cubusCodingAgentRecipe,
    recipeOptions: undefined,
    ...(options.approval === undefined ? {} : { permissionProfile: options.approval }),
    ...(budget === undefined ? {} : { budget }),
    // 重试由循环做（F4b）：每次重试进日志（request/retry），而不是在适配器层悄悄重试
    retry: { maxAttempts: options.maxModelAttempts ?? 3 },
    ...(dependencies.generateId === undefined ? {} : { generateId: dependencies.generateId }),
  })
  const session = await runtime.create()
  dependencies.signal?.throwIfAborted()
  // 诚实性（C2）：模型动手之前，先如实说明这次的执行边界。
  // 事实来自装配快照（日志第一条），不来自任何猜测。
  const mount = await runtime.mountSnapshot(session.id)
  dependencies.output?.write(describeSandbox(mount))
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
  const budgetState = budget === undefined ? undefined : runtime.budgetState(session.id)

  return {
    sessionId: session.id,
    logPath: session.logPath,
    cancelled,
    ...(run.assistantText === undefined ? {} : { assistantText: run.assistantText }),
    turnEvents: run.turnEvents,
    changes,
    ...(budgetState === undefined || budget === undefined
      ? {}
      : { budget: { limits: budget, state: budgetState } }),
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
  if (result.budget !== undefined) {
    output.write(describeBudget(result.budget.state, result.budget.limits))
  }
  if (result.budget?.state.tripped !== undefined) {
    output.write('status: cancelled (budget: ' + result.budget.state.tripped + ')')
  } else if (result.cancelled) {
    output.write('status: cancelled')
  } else {
    output.write(`assistant: ${result.assistantText ?? ''}`)
  }
}

export const CODING_COMMAND_HELP = `Usage:
  pnpm run cubus -- coding --workspace <path> --task <text> --trust-workspace [--approval ask|allow|deny] [--max-model-attempts 1..10] [--max-steps <n>] [--max-tool-calls <n>] [--max-duration <seconds>] [--sessions-dir <path>]

Safety:
  --trust-workspace is required. Approval defaults to the recipe manifest. Local bash is not sandboxed.
  Budget defaults come from the recipe manifest and can be tightened per run.`
