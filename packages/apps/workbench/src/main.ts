/**
 * 工作台入口（E3）：真模型 + 显式审批档 + 本地 HTTP 服务。
 *
 *   pnpm run workbench -- --workspace <path> --approval allow|deny [--port 4173] [--sessions-dir <path>]
 *
 * 两条安全纪律：
 * 1. **审批档必须显式给出**（与 CLI 的 --trust-workspace 同源）：默认不是 allow；
 * 2. **会话目录必须在工作区之外**：agent 的 bash 工具能写工作区，日志不该在它的射程内。
 *
 * 交互式审批（页面上回答 allow/deny）是 E5；v1 只有静态档 allow / deny。
 */
import { mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { CredentialsError, LocalCredentials } from '@cubus/credentials'
import { createLocalAgentHost } from '@cubus/host-local'
import { codingAgentRecipe } from '@cubus/recipe-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { createInteractiveToolApproval, createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import type { InteractiveApproval } from '@cubus/tool-approval'
import { createModelAdapterFactory, loadEnvFile, MODEL_CREDENTIAL_NAME, readDeepSeekEnvironment } from './config.ts'
import { startWorkbenchServer } from './server.ts'

export interface WorkbenchCommandOptions {
  readonly workspace: string
  readonly sessionsDir: string
  readonly approval: 'ask' | 'allow' | 'deny'
  readonly approvalTimeoutMs: number
  readonly port: number
  readonly maxAttempts: number
}

export class WorkbenchUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkbenchUsageError'
  }
}

function optionValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new WorkbenchUsageError(option + ' requires a value')
  }
  return value
}

export function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith('..' + sep) && path !== '..')
}

export function parseWorkbenchCommand(argv: readonly string[]): {
  help: boolean
  options?: WorkbenchCommandOptions
} {
  // pnpm run 会把分隔符 -- 原样传给脚本（与 CLI/评测入口同一个坑），先剥掉。
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let workspace: string | undefined
  let sessionsDir: string | undefined
  let approval: 'ask' | 'allow' | 'deny' | undefined
  let approvalTimeoutMs = 120_000
  let port = 4173
  let maxAttempts = 3

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--workspace') {
      workspace = optionValue(args, index, arg)
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
        throw new WorkbenchUsageError('--approval must be ask, allow or deny')
      }
      approval = value
      index += 1
      continue
    }
    if (arg === '--approval-timeout') {
      const seconds = Number(optionValue(args, index, arg))
      if (!Number.isInteger(seconds) || seconds < 1) {
        throw new WorkbenchUsageError('--approval-timeout must be a positive integer (seconds)')
      }
      approvalTimeoutMs = seconds * 1000
      index += 1
      continue
    }
    if (arg === '--port' || arg === '--max-attempts') {
      const value = Number(optionValue(args, index, arg))
      if (!Number.isInteger(value) || value < (arg === '--port' ? 0 : 1)) {
        throw new WorkbenchUsageError(arg + ' must be a ' + (arg === '--port' ? 'non-negative' : 'positive') + ' integer')
      }
      if (arg === '--port') port = value
      else maxAttempts = value
      index += 1
      continue
    }
    throw new WorkbenchUsageError('unknown option: ' + String(arg))
  }

  if (workspace === undefined) throw new WorkbenchUsageError('workbench requires --workspace <path>')
  if (approval === undefined) {
    throw new WorkbenchUsageError(
      'workbench requires an explicit --approval allow|deny (allow lets the agent run tools in the workspace)',
    )
  }

  return {
    help: false,
    options: {
      workspace,
      sessionsDir: sessionsDir ?? join(tmpdir(), 'cubus-workbench-sessions'),
      approval,
      approvalTimeoutMs,
      port,
      maxAttempts,
    },
  }
}

export const WORKBENCH_COMMAND_HELP = `Usage:
  pnpm run workbench -- --workspace <path> --approval ask|allow|deny [--approval-timeout <seconds>] [--port 4173] [--sessions-dir <path>] [--max-attempts 3]

Safety:
  --approval is required: "ask" waits for Allow/Deny on the page (unanswered calls are denied after
  --approval-timeout seconds, default 120); "allow" lets the agent read and write in the workspace;
  "deny" records tool calls but blocks execution.
  The sessions directory defaults to a temp dir and must stay outside the workspace.
  The server binds 127.0.0.1 only and has no authentication (ADR workbench-protocol.md §6).`

async function main(args: readonly string[]): Promise<number> {
  const parsed = parseWorkbenchCommand(args)
  if (parsed.help) {
    process.stdout.write(WORKBENCH_COMMAND_HELP + '\n')
    return 0
  }
  const options = parsed.options!

  const workspace = await realpath(resolve(options.workspace)).catch(() => {
    throw new WorkbenchUsageError('workspace does not exist: ' + options.workspace)
  })
  const sessionsDir = resolve(options.sessionsDir)
  if (isWithin(workspace, sessionsDir)) {
    throw new WorkbenchUsageError('sessions directory must be outside the tool-writable workspace')
  }
  await mkdir(sessionsDir, { recursive: true })

  // .env：先看工作区，再看仓库根（两级都试，缺了就让下面的 key 检查报明确错误）
  loadEnvFile(join(workspace, '.env'), process.env)
  loadEnvFile(join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '.env'), process.env)
  const settings = readDeepSeekEnvironment(process.env)

  const credentials = new LocalCredentials({
    sources: { [MODEL_CREDENTIAL_NAME]: () => settings.DEEPSEEK_API_KEY },
  })
  let adapterFactory: Awaited<ReturnType<typeof createModelAdapterFactory>>
  try {
    adapterFactory = await createModelAdapterFactory({ credentials, settings, maxAttempts: options.maxAttempts })
  } catch (error) {
    if (error instanceof CredentialsError) {
      throw new WorkbenchUsageError('DEEPSEEK_API_KEY is required in the environment or repository .env')
    }
    throw error
  }

  // 审批策略：ask 是交互式（页面上回答，超时默认拒绝）；allow/deny 是静态档。
  const approval = options.approval === 'ask'
    ? createInteractiveToolApproval({ profile: 'ask', timeoutMs: options.approvalTimeoutMs })
    : createStaticToolApproval(options.approval, 'workbench --approval ' + options.approval)

  const runtime = new SessionRuntime({
    rootDir: sessionsDir,
    host: withToolApprovalHost(
      createLocalAgentHost({ adapterFactory, workspaceDir: workspace, credentials }),
      approval,
    ),
    recipe: codingAgentRecipe,
    recipeOptions: undefined,
    permissionProfile: options.approval,
  })

  const server = await startWorkbenchServer({
    runtime,
    workspaceDir: workspace,
    ...(options.approval === 'ask' ? { approval: approval as InteractiveApproval } : {}),
  }, { port: options.port })
  process.stdout.write('workbench: ' + server.url + '\n')
  process.stdout.write('workspace: ' + workspace + '\n')
  process.stdout.write('sessions:  ' + sessionsDir + '\n')
  process.stdout.write(
    'approval:  ' + options.approval +
    (options.approval === 'ask' ? ' (timeout ' + String(options.approvalTimeoutMs / 1000) + 's -> deny)' : '') + '\n',
  )
  process.stdout.write('model:     ' + (settings.DEEPSEEK_MODEL ?? 'deepseek-chat') + '\n')

  const shutdown = async (): Promise<void> => {
    await server.close()
    process.exit(0)
  }
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  return 0
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (isMain) {
  // 注意：服务启动成功后**不要** process.exit —— 事件循环由监听中的 HTTP 服务保持，
  // 退出只发生在启动失败，或收到 SIGINT/SIGTERM（见 main 里的 shutdown）。
  main(process.argv.slice(2)).catch(error => {
    if (error instanceof WorkbenchUsageError) {
      process.stderr.write(error.message + '\n\n' + WORKBENCH_COMMAND_HELP + '\n')
      process.exit(2)
    }
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
    process.exit(1)
  })
}
