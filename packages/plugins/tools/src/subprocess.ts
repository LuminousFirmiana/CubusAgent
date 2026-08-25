import { spawn } from 'node:child_process'

/**
 * subprocess seam 的 Service Definition（最小版）。
 * 所有命令执行都走这里 —— 沙箱后置时换 provider（容器/E2B）即迁移全部。
 */
export interface SubprocessProvider {
  run(command: string, options: {
    cwd: string
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<SubprocessResult>
}

export interface SubprocessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const SENSITIVE_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD)/i

/** Keep ordinary command configuration while withholding harness credentials. */
function subprocessEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !SENSITIVE_ENV_NAME.test(name)),
  )
}

/** 本地 provider：在进程文件系统里 spawn shell。 */
export class LocalSubprocess implements SubprocessProvider {
  async run(command: string, options: {
    cwd: string
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<SubprocessResult> {
    options.signal.throwIfAborted()
    // shell: true 硬编码 /bin/sh；某些沙箱环境没有它。优先用用户的 $SHELL。
    const shell = process.env['SHELL'] || true
    const child = spawn(command, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: subprocessEnv(),
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined

    const killProcessTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      if (process.platform !== 'win32') {
        try {
          process.kill(-child.pid, signal)
          return
        } catch {
          // The process group may already be gone; fall back to the direct child.
        }
      }
      child.kill(signal)
    }

    const onAbort = (): void => {
      aborted = true
      killProcessTree('SIGTERM')
      forceKillTimer = setTimeout(() => killProcessTree('SIGKILL'), 100)
    }
    options.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', chunk => {
      // 上限 256KB：防超大输出撑爆日志
      if (stdout.length < 256 * 1024) stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < 256 * 1024) stderr += String(chunk)
    })

    const timeoutMs = options.timeoutMs ?? 30_000
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree('SIGKILL')
    }, timeoutMs)

    // 'error' 与 'close' 谁先来以谁为准：spawn 失败（如 shell 不存在）时
    // 必须处理 error，否则 Node 抛出未处理事件直接崩掉整个进程。
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timer)
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
        options.signal.removeEventListener('abort', onAbort)
      }
      const rejectAbort = (): void => {
        if (settled) return
        settled = true
        // The direct child may close before a descendant that ignored SIGTERM.
        killProcessTree('SIGKILL')
        cleanup()
        reject(options.signal.reason)
      }
      child.once('error', error => {
        if (settled) return
        if (aborted) {
          rejectAbort()
          return
        }
        settled = true
        cleanup()
        stderr += 'spawn failed (cwd: ' + options.cwd + '): ' + error.message
        resolve(null)
      })
      child.once('close', code => {
        if (settled) return
        if (aborted) {
          rejectAbort()
          return
        }
        settled = true
        cleanup()
        resolve(code)
      })
    })

    return { exitCode, stdout, stderr, timedOut }
  }
}
