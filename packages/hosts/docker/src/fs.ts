import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FsError } from '@cubus/tools'
import type { FsProvider } from '@cubus/tools'
import type { DockerClient } from './client.ts'

/** 与 LocalFs 相同的路径纪律：相对路径、不许 ..、不许绝对路径。 */
export function resolveInWorkdir(workdir: string, path: string): string {
  const normalized = path.replace(/\\/g, '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new FsError('path escapes workspace: ' + path)
  }
  return workdir + '/' + normalized
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/** 容器内文件系统：读写都发生在容器里，宿主工作区只能通过 bind mount 出现。 */
export class DockerFs implements FsProvider {
  private readonly client: DockerClient
  private readonly container: string
  private readonly workdir: string
  private readonly signal: AbortSignal

  constructor(client: DockerClient, container: string, workdir: string) {
    this.client = client
    this.container = container
    this.workdir = workdir
    this.signal = new AbortController().signal
  }

  async readText(path: string): Promise<string> {
    const target = resolveInWorkdir(this.workdir, path)
    const result = await this.client.exec(this.container, 'cat ' + quote(target), {
      workdir: this.workdir,
      signal: this.signal,
    })
    if (result.exitCode !== 0) {
      throw new FsError('cannot read ' + path + ': ' + (result.stderr.trim() || 'exit ' + String(result.exitCode)))
    }
    return result.stdout
  }

  async writeText(path: string, content: string): Promise<void> {
    const target = resolveInWorkdir(this.workdir, path)
    // docker cp 不会创建父目录：先把目录建好（容器内命令，不碰宿主）。
    const parent = target.slice(0, target.lastIndexOf('/'))
    if (parent !== '' && parent !== this.workdir) {
      const made = await this.client.exec(this.container, 'mkdir -p ' + quote(parent), {
        workdir: this.workdir,
        signal: this.signal,
      })
      if (made.exitCode !== 0) {
        throw new FsError('cannot create directory for ' + path + ': ' + made.stderr.trim())
      }
    }
    const staging = await mkdtemp(join(tmpdir(), 'cubus-docker-fs-'))
    try {
      const hostPath = join(staging, 'payload')
      await writeFile(hostPath, content, 'utf8')
      await this.client.copyIn(this.container, hostPath, target)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
