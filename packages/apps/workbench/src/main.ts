/**
 * 工作台入口（F1）：真模型 + 显式审批档 + 本地 HTTP 服务 + 配置文件。
 *
 *   pnpm run workbench                       # 读 ~/.cubus/config.json
 *   pnpm run workbench -- --init             # 生成一份配置模板（当前目录作为工作区）
 *   pnpm run workbench -- --workspace <path> --approval allow --port 4173
 *
 * 优先级：**命令行 > 配置文件 > 内置默认**。
 *
 * 两条安全纪律（不因方便而放松）：
 * 1. **审批档必须显式给出**（命令行或配置文件都算显式）：默认不是 allow；
 * 2. **会话目录必须在工作区之外**：agent 的 bash 工具能写工作区，日志不该在它的射程内。
 */
import { mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { CredentialsError, LocalCredentials } from '@cubus/credentials'
import { createLocalAgentHost } from '@cubus/host-local'
import { cubusCodingAgentRecipe } from '@cubus/recipe-cubus-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { createInteractiveToolApproval, createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import type { InteractiveApproval } from '@cubus/tool-approval'
import {
  createDeepSeekAdapterFactory,
  loadDeepSeekEnvFile,
  MODEL_CREDENTIAL_NAME,
  readDeepSeekEnvironment,
} from '@cubus/llm-deepseek'
import type { DeepSeekEnvironment } from '@cubus/llm-deepseek'
import {
  configPathFrom,
  readWorkbenchConfig,
  writeWorkbenchConfig,
} from './config-file.ts'
import type { WorkbenchConfigFile } from './config-file.ts'
import { startWorkbenchServer } from './server.ts'

export interface WorkbenchCommandOptions {
  readonly workspace: string
  readonly sessionsDir: string
  readonly approval: 'ask' | 'allow' | 'deny'
  readonly approvalTimeoutMs: number
  readonly port: number
  readonly maxAttempts: number
}

/** 命令行给出的覆盖（全部可选：缺的从配置文件取，再缺用默认）。 */
export interface WorkbenchOverrides {
  readonly workspace?: string
  readonly sessionsDir?: string
  readonly approval?: 'ask' | 'allow' | 'deny'
  readonly approvalTimeoutSeconds?: number
  readonly port?: number
  readonly maxAttempts?: number
  readonly model?: string
}

export interface ParsedWorkbenchCommand {
  readonly help: boolean
  readonly init: boolean
  readonly force: boolean
  readonly configFlag?: string
  readonly overrides: WorkbenchOverrides
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

export function parseWorkbenchCommand(argv: readonly string[]): ParsedWorkbenchCommand {
  // pnpm run 会把分隔符 -- 原样传给脚本（与 CLI/评测入口同一个坑），先剥掉。
  const args = argv[0] === '--' ? argv.slice(1) : argv
  const overrides: {
    workspace?: string
    sessionsDir?: string
    approval?: 'ask' | 'allow' | 'deny'
    approvalTimeoutSeconds?: number
    port?: number
    maxAttempts?: number
    model?: string
  } = {}
  let init = false
  let force = false
  let configFlag: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--help' || arg === '-h') return { help: true, init: false, force: false, overrides }
    if (arg === '--init') {
      init = true
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--config') {
      configFlag = optionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg === '--workspace') {
      overrides.workspace = optionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg === '--sessions-dir') {
      overrides.sessionsDir = optionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg === '--approval') {
      const value = optionValue(args, index, arg)
      if (value !== 'ask' && value !== 'allow' && value !== 'deny') {
        throw new WorkbenchUsageError('--approval must be ask, allow or deny')
      }
      overrides.approval = value
      index += 1
      continue
    }
    if (arg === '--approval-timeout') {
      const seconds = Number(optionValue(args, index, arg))
      if (!Number.isInteger(seconds) || seconds < 1) {
        throw new WorkbenchUsageError('--approval-timeout must be a positive integer (seconds)')
      }
      overrides.approvalTimeoutSeconds = seconds
      index += 1
      continue
    }
    if (arg === '--port' || arg === '--max-attempts') {
      const value = Number(optionValue(args, index, arg))
      if (!Number.isInteger(value) || value < (arg === '--port' ? 0 : 1)) {
        throw new WorkbenchUsageError(arg + ' must be a ' + (arg === '--port' ? 'non-negative' : 'positive') + ' integer')
      }
      if (arg === '--port') overrides.port = value
      else overrides.maxAttempts = value
      index += 1
      continue
    }
    throw new WorkbenchUsageError('unknown option: ' + String(arg))
  }

  return {
    help: false,
    init,
    force,
    ...(configFlag === undefined ? {} : { configFlag }),
    overrides,
  }
}

/** 合并命令行与配置文件（命令行优先），补齐默认，并校验必需项。 */
export function resolveWorkbenchOptions(
  overrides: WorkbenchOverrides,
  config: WorkbenchConfigFile | undefined,
  options: { configPath: string } = { configPath: '~/.cubus/config.json' },
): WorkbenchCommandOptions {
  const workspace = overrides.workspace ?? config?.workspace
  if (workspace === undefined) {
    throw new WorkbenchUsageError(
      'workbench requires a workspace: pass --workspace <path> or set "workspace" in ' + options.configPath +
      ' (run with --init to write a starter config)',
    )
  }
  const approval = overrides.approval ?? config?.approval
  if (approval === undefined) {
    throw new WorkbenchUsageError(
      'workbench requires an explicit approval level: pass --approval ask|allow|deny or set "approval" in ' +
      options.configPath + ' (allow lets the agent run tools in the workspace)',
    )
  }
  const approvalTimeoutSeconds = overrides.approvalTimeoutSeconds ?? config?.approvalTimeoutSeconds ?? 120

  return {
    workspace,
    // 与 CLI 同一个默认位置：~/.cubus/sessions（持久、可找、和 ~/.cubus/config.json 同处）。
    // 早先这里是系统临时目录：重启可能被清理，metrics/archive 也就找不到日志了。
    sessionsDir: overrides.sessionsDir ?? config?.sessionsDir ?? join(homedir(), '.cubus', 'sessions'),
    approval,
    approvalTimeoutMs: approvalTimeoutSeconds * 1000,
    port: overrides.port ?? config?.port ?? 4173,
    maxAttempts: overrides.maxAttempts ?? config?.maxAttempts ?? 3,
  }
}

export const WORKBENCH_COMMAND_HELP = `Usage:
  pnpm run workbench [options]

Options:
  --workspace <path>            agent 的读写边界（默认取配置文件的 workspace）
  --approval ask|allow|deny     审批档（必填，命令行或配置文件都算显式）
  --approval-timeout <seconds>  ask 档的等待上限，超时按拒绝（默认 120）
  --port <n>                    监听端口（默认 4173，只监听 127.0.0.1）
  --sessions-dir <path>         会话日志目录（必须在工作区之外）
  --max-attempts <n>            模型请求重试次数（默认 3）
  --config <path>               配置文件路径（默认 $CUBUS_CONFIG 或 ~/.cubus/config.json）
  --init                        生成配置模板后退出（已有配置时不覆盖，除非 --force）
  --force                       与 --init 同用：覆盖已有配置
  -h, --help                    显示本帮助

Safety:
  "ask" 在页面上等 Allow/Deny；"allow" 让 agent 直接读写工作区；"deny" 只记录不执行。
  会话目录默认在临时目录，且必须在工作区之外。
  服务只监听回环地址且没有鉴权（见 docs/design/workbench-protocol.md §6）。`

async function main(args: readonly string[]): Promise<number> {
  const parsed = parseWorkbenchCommand(args)
  if (parsed.help) {
    process.stdout.write(WORKBENCH_COMMAND_HELP + '\n')
    return 0
  }

  const configPath = configPathFrom({
    ...(parsed.configFlag === undefined ? {} : { flag: parsed.configFlag }),
    env: process.env,
  })

  if (parsed.init) {
    // --workspace 显式给了就用它；没给才回落到当前目录（静默忽略显式参数是最糟的选择）
    const workspaceForInit = parsed.overrides.workspace ?? process.cwd()
    const outcome = await writeWorkbenchConfig(configPath, workspaceForInit, { force: parsed.force })
    if (outcome === 'exists') {
      process.stderr.write('config already exists: ' + configPath + ' (pass --force to overwrite)\n')
      return 2
    }
    process.stdout.write('wrote ' + configPath + '\n')
    process.stdout.write('edit it, then run: pnpm run workbench\n')
    return 0
  }

  const loaded = await readWorkbenchConfig(configPath)
  if (loaded === undefined && parsed.configFlag !== undefined) {
    throw new WorkbenchUsageError('config file not found: ' + configPath)
  }
  const options = resolveWorkbenchOptions(parsed.overrides, loaded?.config, { configPath })

  const workspace = await realpath(resolve(options.workspace)).catch(() => {
    throw new WorkbenchUsageError('workspace does not exist: ' + options.workspace)
  })
  const sessionsDir = resolve(options.sessionsDir)
  if (isWithin(workspace, sessionsDir)) {
    throw new WorkbenchUsageError('sessions directory must be outside the tool-writable workspace')
  }
  await mkdir(sessionsDir, { recursive: true })

  // 模型设置优先级：命令行/配置文件 > 进程环境 > 工作区 .env > 仓库根 .env
  // （readDeepSeekEnvironment(env, file) = 进程环境优先，其次该文件；仓库根再垫在下面）
  const fromRepository = await loadDeepSeekEnvFile(join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '.env'))
  const fromProcessAndWorkspace = await readDeepSeekEnvironment(process.env, join(workspace, '.env'))
  const overrides = parsed.overrides.model ?? loaded?.config.model
  const settings: DeepSeekEnvironment = {
    ...fromRepository,
    ...fromProcessAndWorkspace,
    ...(overrides === undefined ? {} : { DEEPSEEK_MODEL: overrides }),
  }

  const credentials = new LocalCredentials({
    sources: { [MODEL_CREDENTIAL_NAME]: () => settings.DEEPSEEK_API_KEY },
  })
  let adapterFactory: Awaited<ReturnType<typeof createDeepSeekAdapterFactory>>
  try {
    adapterFactory = await createDeepSeekAdapterFactory({ credentials, settings })
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
    recipe: cubusCodingAgentRecipe,
    recipeOptions: undefined,
    permissionProfile: options.approval,
    // 重试由循环做（F4b）：每次重试进日志
    retry: { maxAttempts: options.maxAttempts },
  })

  const server = await startWorkbenchServer({
    runtime,
    workspaceDir: workspace,
    ...(options.approval === 'ask' ? { approval: approval as InteractiveApproval } : {}),
  }, { port: options.port })
  process.stdout.write('workbench: ' + server.url + '\n')
  process.stdout.write('workspace: ' + workspace + '\n')
  process.stdout.write('sessions:  ' + sessionsDir + '\n')
  process.stdout.write('config:    ' + (loaded === undefined ? configPath + ' (not found, using defaults)' : loaded.path) + '\n')
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
