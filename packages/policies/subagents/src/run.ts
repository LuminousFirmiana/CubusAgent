import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 子 Agent 结果契约（父从子进程拿到的东西 —— 只有结论与指针，不含子的过程）。 */
export interface SubagentResult {
  readonly ok: boolean
  readonly id: string
  readonly sessionId?: string
  readonly summary: string
  readonly changedFiles: readonly string[]
  readonly worktree?: { readonly path: string; readonly branch: string; readonly commit?: string }
  readonly stats?: { readonly steps?: number; readonly toolCalls?: number; readonly tokens?: number; readonly ms?: number }
  readonly exitCode: number
  readonly stderrTail?: string
}

export interface SpawnSubagentOptions {
  /** 稳定的 id（进父日志与 worktree 分支名，形如 `sa-<slug>`）。 */
  readonly id: string
  readonly task: string
  /** 子进程的 cwd（worktree 或父工作区）。 */
  readonly cwd: string
  /** 结果文件路径（子进程写 JSON，父读它取契约）。 */
  readonly resultPath: string
  /** 子 Agent 定义名（runner 据此挑工具白名单）。 */
  readonly agent: string
  /** runner 脚本路径：**由 app 决定**（policy 层不依赖 sdk/产品，装配在 app 层）。 */
  readonly runnerPath: string
  readonly env?: Readonly<Record<string, string>>
  /** 超时（默认 10 分钟）：超时杀进程组并返回 ok:false。 */
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly worktree?: { readonly path: string; readonly branch: string; readonly commit?: string }
  /** 允许注入的额外 CLI 参数（测试用）。 */
  readonly extraArgs?: readonly string[]
}

/**
 * tsx 的 loader 必须用**绝对路径**：`--import tsx/esm` 要靠 cwd 里的 node_modules 解析，
 * 而子进程的 cwd 是工作区/worktree（可能根本不在仓库里）—— 实测就会变成"子进程启动失败，退出码 1"。
 */
function resolveTsxLoader(): string {
  try {
    return createRequire(import.meta.url).resolve('tsx/esm')
  } catch {
    return 'tsx/esm'
  }
}
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 起一个子 Agent 进程并等它结束（S6.2）。
 *
 * 三条纪律：
 * 1. **不共享内存**：父只从结果文件读 JSON，子崩溃/超时都只影响它自己；
 * 2. **杀进程组**：超时与取消时 `detached` + 负 pid，连同孙进程一起收掉；
 * 3. **失败也要有结果**：崩溃/超时/结果文件缺失都返回 `ok:false` + `stderrTail`，
 *    父据此决定是重试、换人还是转人工 —— 不允许"静默没结果"。
 */
export async function spawnSubagent(options: SpawnSubagentOptions): Promise<SubagentResult> {
  const runnerPath = options.runnerPath
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const args = ['--import', resolveTsxLoader(), runnerPath, '--agent', options.agent, '--task', options.task, '--result', options.resultPath, ...(options.extraArgs ?? [])]
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...(process.env as Record<string, string>), ...options.env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout += String(chunk) })
  child.stderr?.on('data', chunk => { stderr += String(chunk) })

  let timedOut = false
  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal)
    } catch {
      // 进程已经没了：忽略
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    killGroup('SIGTERM')
    setTimeout(() => killGroup('SIGKILL'), 1500).unref()
  }, timeoutMs)
  const onAbort = (): void => {
    killGroup('SIGTERM')
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => resolve(code ?? 1))
  })
  clearTimeout(timer)
  options.signal?.removeEventListener('abort', onAbort)

  const stderrTail = stderr.slice(-2000)
  // 结果文件优先：它是契约；没有就跑失败
  try {
    const parsed = JSON.parse(readFileSync(options.resultPath, 'utf8')) as SubagentResult
    return {
      ...parsed,
      id: parsed.id === '' ? options.id : parsed.id,
      ok: parsed.ok && !timedOut && exitCode === 0,
      exitCode,
      ...(parsed.ok && !timedOut && exitCode === 0 ? {} : { stderrTail }),
    }
  } catch {
    return {
      ok: false,
      id: options.id,
      summary: timedOut ? 'subagent timed out after ' + String(timeoutMs) + 'ms' : 'subagent produced no result file',
      changedFiles: [],
      ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
      exitCode,
      stderrTail,
    }
  }
}