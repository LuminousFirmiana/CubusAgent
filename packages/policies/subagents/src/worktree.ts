import { mkdirSync, realpathSync } from 'node:fs'

/** 跑一条 git 命令；注入是为了让单测能用真仓库、也能用假实现。 */
export interface GitRunner {
  (cwd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }>
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeError'
  }
}

/** 规范化路径（不存在时退回原值）。 */
function canonical(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** slug：进目录名、分支名与 git 参数，必须严格（防路径注入与参数注入）。 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/

export function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new WorktreeError(
      'invalid worktree slug "' + slug + '": expected ^[a-z0-9][a-z0-9-]{0,40}$ (lowercase letters, digits, dashes)',
    )
  }
}

export interface Worktree {
  readonly slug: string
  readonly path: string
  readonly branch: string
}

export interface WorktreeManagerOptions {
  /** 主仓库工作区（有 `.git` 的那个目录）。 */
  readonly repositoryDir: string
  /** worktree 的存放根目录（与仓库同级会污染仓库，所以放外面）。 */
  readonly worktreesDir: string
  readonly git: GitRunner
  /** 分支前缀，默认 `cubus/`。 */
  readonly branchPrefix?: string
}

export interface WorktreeChanges {
  readonly files: readonly string[]
  readonly commit?: string
}

/**
 * Git worktree 管理（S6.2）。
 *
 * 与参考实现的三处刻意差异：
 * 1. **不切进程 cwd**（参考实现踩过：cwd 是全局可变状态，并发组件会互相污染）——路径只交给子进程；
 * 2. 分支用 `-B` 重置（上次遗留的孤儿分支不该让这次创建失败）；
 * 3. **删除必须显式 discard**：未提交的改动意味着可能丢掉几小时的工作，默认保留。
 */
export class WorktreeManager {
  private readonly repositoryDir: string
  private readonly worktreesDir: string
  private readonly git: GitRunner
  private readonly branchPrefix: string

  constructor(options: WorktreeManagerOptions) {
    // 规范化：git 报的是真实路径（macOS 上 /var 是 /private/var 的符号链接），
    // 不规范化会让"这个 worktree 已存在"的判断永远为假，于是重复 add 直接报错。
    this.repositoryDir = canonical(options.repositoryDir)
    // worktrees 根目录可能还不存在：先建出来再规范化（否则 realpath 会退回未规范化的路径，
    // 于是"这个 worktree 已存在"的判断永远为假，重复 add 直接报错 —— 实测踩过）
    mkdirSync(options.worktreesDir, { recursive: true })
    this.worktreesDir = canonical(options.worktreesDir)
    this.git = options.git
    this.branchPrefix = options.branchPrefix ?? 'cubus/'
  }

  async isGitRepository(): Promise<boolean> {
    const result = await this.git(this.repositoryDir, ['rev-parse', '--is-inside-work-tree'])
    return result.code === 0 && result.stdout.trim() === 'true'
  }

  /** 创建（或复用）一个 worktree。已存在时复用并返回，不重复 add。 */
  async create(slug: string): Promise<Worktree & { reused: boolean }> {
    assertSlug(slug)
    const path = this.worktreesDir + '/' + slug
    const branch = this.branchPrefix + slug
    const existing = await this.git(this.repositoryDir, ['worktree', 'list', '--porcelain'])
    if (existing.code !== 0) throw new WorktreeError('git worktree list failed: ' + existing.stderr.trim())
    const reused = existing.stdout
      .split('\n')
      .filter(line => line.startsWith('worktree '))
      .map(line => canonical(line.slice('worktree '.length)))
      .some(listed => listed === path)
    if (!reused) {
      const added = await this.git(this.repositoryDir, ['worktree', 'add', '-B', branch, path])
      if (added.code !== 0) throw new WorktreeError('git worktree add failed: ' + added.stderr.trim())
    }
    return { slug, path, branch, reused }
  }

  /** worktree 里的未提交改动（`git status --porcelain` 的第一列路径）。 */
  async changes(worktree: Worktree): Promise<WorktreeChanges> {
    const status = await this.git(worktree.path, ['status', '--porcelain'])
    if (status.code !== 0) throw new WorktreeError('git status failed: ' + status.stderr.trim())
    const files = status.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .map(line => line.slice(2).trim())
    return { files }
  }

  /**
   * 把 worktree 里的改动提交到**它自己的分支**（子 Agent 结束时调用）。
   * 没有改动时返回 undefined（不产生空提交）。
   */
  async commit(worktree: Worktree, message: string): Promise<WorktreeChanges> {
    const before = await this.changes(worktree)
    if (before.files.length === 0) return { files: [] }
    const added = await this.git(worktree.path, ['add', '-A'])
    if (added.code !== 0) throw new WorktreeError('git add failed: ' + added.stderr.trim())
    const committed = await this.git(worktree.path, ['commit', '-m', message, '--no-verify'])
    if (committed.code !== 0) throw new WorktreeError('git commit failed: ' + committed.stderr.trim())
    const head = await this.git(worktree.path, ['rev-parse', 'HEAD'])
    return {
      files: before.files,
      ...(head.code === 0 ? { commit: head.stdout.trim().slice(0, 12) } : {}),
    }
  }

  /**
   * 删除 worktree 与分支。**必须显式 discard**：有未提交改动时默认拒绝（防误删）。
   */
  async remove(slug: string, options: { discard?: boolean } = {}): Promise<void> {
    assertSlug(slug)
    const path = this.worktreesDir + '/' + slug
    const branch = this.branchPrefix + slug
    const worktree: Worktree = { slug, path, branch }
    const changes = await this.changes(worktree).catch(() => ({ files: [] }))
    if (changes.files.length > 0 && options.discard !== true) {
      throw new WorktreeError(
        'refusing to remove worktree "' + slug + '": ' + String(changes.files.length) +
        ' uncommitted change(s) would be lost (pass discard: true to force)',
      )
    }
    await this.git(this.repositoryDir, ['worktree', 'remove', '--force', path])
    await this.git(this.repositoryDir, ['branch', '-D', branch])
  }

  list(): Promise<string[]> {
    return this.git(this.repositoryDir, ['worktree', 'list', '--porcelain']).then(result =>
      result.stdout.split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length)))
  }
}

/** 本机 git：用 `spawn` 跑，不经 shell（参数不会被二次解析）。 */
export function nodeGitRunner(spawn: typeof import('node:child_process').spawn): GitRunner {
  return async (cwd, args) => {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      child.on('error', reject)
      child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }))
    })
  }
}