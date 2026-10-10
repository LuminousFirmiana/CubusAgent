import { tmpdir } from 'node:os'
import type { SubprocessProvider, SubprocessResult } from '@cubus/tools'
import {
  containerName,
  containerRemoveArgs,
  containerRunArgs,
  copyInArgs,
  execArgs,
  killProcessGroupArgs,
} from './spec.ts'
import type { DockerSandboxSpec } from './spec.ts'

export class DockerError extends Error {
  readonly exitCode: number | null

  constructor(message: string, exitCode: number | null) {
    super(message)
    this.name = 'DockerError'
    this.exitCode = exitCode
  }
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/** 生命周期命令（起容器 / 删容器 / 拷贝）不参与用户取消，只受超时约束。 */
const LIFECYCLE_TIMEOUT_MS = 120_000

/**
 * docker CLI 的薄封装：**宿主侧**调用（容器内的一切都经 docker exec）。
 *
 * 它通过 subprocess seam 运行，因此环境同样走白名单；默认只多放行
 * DOCKER_HOST / DOCKER_CONTEXT（远端 daemon 需要），不含 DOCKER_CONFIG（那里有 registry 凭据）。
 */
export class DockerClient {
  private readonly subprocess: SubprocessProvider
  private readonly idleSignal = new AbortController().signal
  /** 每次 exec 一个 pid 文件：串行命令之间不互相踩。 */
  private execCounter = 0
  /** 清理失败的观察点（默认忽略：清理是尽力而为，但调用方可以记账）。 */
  private onProcessGroupKillFailure: ((message: string) => void) | undefined

  constructor(subprocess: SubprocessProvider, options: { onProcessGroupKillFailure?: (message: string) => void } = {}) {
    this.subprocess = subprocess
    this.onProcessGroupKillFailure = options.onProcessGroupKillFailure
  }

  private async docker(args: readonly string[], options: {
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<SubprocessResult> {
    const command = 'docker ' + args.map(quote).join(' ')
    return await this.subprocess.run(command, {
      cwd: tmpdir(),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? LIFECYCLE_TIMEOUT_MS,
    })
  }

  /** 起容器并返回容器名；失败时抛错（含 docker 的 stderr，便于定位）。 */
  async startContainer(spec: DockerSandboxSpec): Promise<string> {
    const result = await this.docker(containerRunArgs(spec), { signal: this.idleSignal })
    if (result.exitCode !== 0) {
      throw new DockerError(
        'docker run failed (' + String(result.exitCode) + '): ' + (result.stderr.trim() || result.stdout.trim()),
        result.exitCode,
      )
    }
    return containerName(spec.sessionId)
  }

  /** 删容器：尽力而为，但失败要能被看见（调用方决定是否抛）。 */
  async removeContainer(container: string): Promise<SubprocessResult> {
    return await this.docker(containerRemoveArgs(container), { signal: this.idleSignal })
  }

  /**
   * 容器内执行命令；返回原始结果（由调用方决定非零是否算错误）。
   *
   * 取消或超时后**必须连容器内的进程组一起清理**：宿主侧只杀掉了 docker exec 客户端，
   * 容器内的子进程（例如 `sleep 300 &`）会活到容器销毁。做法是让命令以 setsid 起一个
   * 独立进程组并记下组号，取消时按组 TERM -> KILL（argv 构造见 spec.ts）。
   */
  async exec(container: string, command: string, options: {
    workdir: string
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<SubprocessResult> {
    const pidFile = '/tmp/cubus-pgid-' + String(++this.execCounter)
    let aborted = false
    const onAbort = (): void => {
      aborted = true
    }
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await this.docker(execArgs(container, command, options.workdir, pidFile), {
        signal: options.signal,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      })
      // 超时由 subprocess provider 判定：它杀掉宿主侧进程组，但看不见容器内
      if (aborted || result.timedOut) await this.killProcessGroup(container, pidFile)
      return result
    } catch (error) {
      if (aborted) await this.killProcessGroup(container, pidFile)
      throw error
    } finally {
      options.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 清理容器内的进程组（尽力而为：失败不该掩盖原始错误，但要能被看见）。
   * 走 idleSignal —— 调用方的 signal 此刻多半已经 abort 了。
   */
  private async killProcessGroup(container: string, pidFile: string): Promise<void> {
    const result = await this.docker(killProcessGroupArgs(container, pidFile), {
      signal: this.idleSignal,
      timeoutMs: 20_000,
    }).catch(() => undefined)
    if (result !== undefined && result.exitCode !== 0) {
      this.onProcessGroupKillFailure?.(
        'process group kill exited with ' + String(result.exitCode) + ': ' + result.stderr.trim(),
      )
    }
  }

  /** 宿主文件 -> 容器内路径（写文件用；内容不进命令行，避免出现在 ps 里）。 */
  async copyIn(container: string, hostPath: string, containerPath: string): Promise<void> {
    const result = await this.docker(copyInArgs(container, hostPath, containerPath), { signal: this.idleSignal })
    if (result.exitCode !== 0) {
      throw new DockerError(
        'docker cp failed (' + String(result.exitCode) + '): ' + (result.stderr.trim() || result.stdout.trim()),
        result.exitCode,
      )
    }
  }
}
