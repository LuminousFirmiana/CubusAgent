import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * fs seam 的 Service Definition（最小版）。
 * 工具只依赖这个接口，不直接碰磁盘 —— 沙箱后置的抵押品纪律：
 * P5 换 provider（E2B/容器）时工具零改动。
 */
export interface FsProvider {
  readText(path: string): Promise<string>
  writeText(path: string, content: string): Promise<void>
}

export class FsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FsError'
  }
}

/** 本地 provider：直接读写进程文件系统。 */
export class LocalFs implements FsProvider {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = rootDir
  }

  /** 把相对路径钉在 rootDir 内；越界（..）与绝对路径一律拒绝。 */
  private resolve(path: string): string {
    const normalized = path.replace(/\\/g, '/')
    if (normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new FsError(`path escapes workspace: ${path}`)
    }
    return join(this.rootDir, normalized)
  }

  async readText(path: string): Promise<string> {
    try {
      return await readFile(this.resolve(path), 'utf8')
    } catch (error) {
      throw new FsError(`read failed: ${path} (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    try {
      await writeFile(this.resolve(path), content, 'utf8')
    } catch (error) {
      throw new FsError(`write failed: ${path} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
}

