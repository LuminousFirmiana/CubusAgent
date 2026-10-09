import type { SubprocessProvider, SubprocessResult } from '@cubus/tools'
import type { DockerClient } from './client.ts'

/**
 * 容器内命令执行。
 *
 * - 命令跑在容器里，宿主环境不会随之进入（docker exec 不传宿主 env）；
 * - 工具传的 cwd 是宿主视角的工作区路径，容器内不适用 —— 这里统一用容器内 workdir；
 * - 取消沿用本地 provider 的语义：杀掉 docker exec 进程组（容器内孤儿进程由容器销毁兜底）。
 */
export class DockerSubprocess implements SubprocessProvider {
  private readonly client: DockerClient
  private readonly container: string
  private readonly workdir: string

  constructor(client: DockerClient, container: string, workdir: string) {
    this.client = client
    this.container = container
    this.workdir = workdir
  }

  async run(command: string, options: {
    cwd: string
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<SubprocessResult> {
    options.signal.throwIfAborted()
    return await this.client.exec(this.container, command, {
      workdir: this.workdir,
      signal: options.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
  }
}
