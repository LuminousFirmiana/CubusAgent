import { spawn } from 'node:child_process'

/**
 * subprocess seam 的 Service Definition（最小版）。
 * 所有命令执行都走这里 —— 沙箱后置时换 provider（容器/E2B）即迁移全部。
 */
export interface SubprocessProvider {
  run(command: string, options: { cwd: string; timeoutMs?: number }): Promise<SubprocessResult>
}

export interface SubprocessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** 本地 provider：在进程文件系统里 spawn shell。 */
export class LocalSubprocess implements SubprocessProvider {
  async run(command: string, options: { cwd: string; timeoutMs?: number }): Promise<SubprocessResult> {
    const child = spawn(command, { cwd: options.cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let timedOut = false

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
      child.kill('SIGKILL')
    }, timeoutMs)

    const exitCode = await new Promise<number | null>(resolve => {
      child.on('close', code => resolve(code))
    })
    clearTimeout(timer)

    return { exitCode, stdout, stderr, timedOut }
  }
}

