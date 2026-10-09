import { tmpdir } from 'node:os'
import type { SubprocessProvider, SubprocessResult } from '@cubus/tools'
import {
  containerName,
  containerRemoveArgs,
  containerRunArgs,
  copyInArgs,
  execArgs,
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

  constructor(subprocess: SubprocessProvider) {
    this.subprocess = subprocess
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

  /** 容器内执行命令；返回原始结果（由调用方决定非零是否算错误）。 */
  async exec(container: string, command: string, options: {
    workdir: string
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<SubprocessResult> {
    return await this.docker(execArgs(container, command, options.workdir), {
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
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
