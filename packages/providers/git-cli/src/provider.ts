import type {
  GitBaseline,
  GitChangeKind,
  GitChangedFile,
  GitChangeReport,
  GitFileState,
  GitProbeOptions,
  GitWorkspaceProvider,
} from '@cubus/git'
import type { SubprocessProvider } from '@cubus/tools'

export const NOT_A_REPOSITORY_SUMMARY = 'git: not a repository'

/** POSIX 单引号引用：路径可能含空格或 shell 元字符。 */
function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

/** porcelain 输出里带特殊字符的路径会被双引号包裹并转义。 */
function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value
  const body = value.slice(1, -1)
  return body.replace(/\\([\\"tn]|[0-7]{1,3})/g, (match, token: string) => {
    if (token === 't') return '\t'
    if (token === 'n') return '\n'
    if (token === '"') return '"'
    if (token === '\\') return '\\'
    return String.fromCharCode(Number.parseInt(token, 8))
  })
}

/** git status --porcelain=v1 的一行 -> 文件状态（hash 稍后补齐）。 */
function parseStatusLines(stdout: string): GitFileState[] {
  const files: GitFileState[] = []
  for (const line of stdout.split('\n')) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    files.push({ path: unquoteGitPath(path), status, hash: null })
  }
  return files
}

/** numstat 的一行 -> 行数统计；'-' 表示二进制。 */
function parseNumstatLine(stdout: string): { added: number | null; removed: number | null } | undefined {
  const line = stdout.split('\n').find(candidate => candidate.trim() !== '')
  if (line === undefined) return undefined
  const fields = line.split('\t')
  const added = fields[0] === '-' || fields[0] === undefined ? null : Number.parseInt(fields[0], 10)
  const removed = fields[1] === '-' || fields[1] === undefined ? null : Number.parseInt(fields[1], 10)
  return { added, removed }
}

function kindOf(state: GitFileState): GitChangeKind {
  if (state.status === '??') return 'created'
  if (state.status.startsWith('D') || state.status.endsWith('D')) return 'deleted'
  return 'modified'
}

/** 状态码里含 D 表示工作区文件已不存在 —— 无法取内容哈希。 */
function missingInWorktree(state: GitFileState): boolean {
  return state.status.startsWith('D') || state.status.endsWith('D')
}

function statSuffix(file: GitChangedFile): string {
  if (file.addedLines === null && file.removedLines === null) return ''
  const added = file.addedLines === null ? '?' : String(file.addedLines)
  const removed = file.removedLines === null ? '?' : String(file.removedLines)
  return ' (+' + added + '/-' + removed + ')'
}

/** 摘要由 provider 拥有，渲染方不拼接 Git 语义。 */
export function renderChangeSummary(
  head: string | null,
  changed: readonly GitChangedFile[],
  preexisting: readonly string[],
): string {
  const lines: string[] = []
  lines.push('git: repository at HEAD ' + (head === null ? '(no commits)' : head.slice(0, 7)))
  lines.push('changed: ' + String(changed.length))
  for (const file of changed) lines.push('  ' + file.kind + ' ' + file.path + statSuffix(file))
  if (preexisting.length > 0) {
    lines.push('preexisting (not touched by this run): ' + String(preexisting.length))
    for (const path of preexisting) lines.push('  ' + path)
  }
  return lines.join('\n')
}

interface GitCommandResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * 通过 subprocess seam 调用 git CLI 的只读实现。
 *
 * 只使用检查类命令（rev-parse / status / hash-object / diff）；
 * hash-object 绝不带 -w，diff 绝不写索引。因此本 provider
 * 不会提交、暂存或回滚任何东西。
 */
export class GitCliWorkspaceProvider implements GitWorkspaceProvider {
  private readonly subprocess: SubprocessProvider
  /** 调用方未提供 signal 时使用的常驻信号（探测命令秒级完成）。 */
  private readonly idleSignal: AbortSignal

  constructor(subprocess: SubprocessProvider) {
    this.subprocess = subprocess
    this.idleSignal = new AbortController().signal
  }

  private async git(dir: string, command: string, signal: AbortSignal): Promise<GitCommandResult> {
    const result = await this.subprocess.run('git ' + command, { cwd: dir, signal, timeoutMs: 15_000 })
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr }
  }

  private async head(dir: string, signal: AbortSignal): Promise<string | null> {
    const result = await this.git(dir, 'rev-parse --verify HEAD', signal)
    return result.ok ? result.stdout.trim() : null
  }

  private async hashFile(dir: string, path: string, signal: AbortSignal): Promise<string | null> {
    const result = await this.git(dir, 'hash-object -- ' + quote(path), signal)
    return result.ok ? result.stdout.trim() : null
  }

  private async statusFiles(dir: string, signal: AbortSignal): Promise<GitFileState[]> {
    const result = await this.git(dir, 'status --porcelain=v1 -uall', signal)
    if (!result.ok) return []
    const files: GitFileState[] = []
    for (const state of parseStatusLines(result.stdout)) {
      const hash = missingInWorktree(state) ? null : await this.hashFile(dir, state.path, signal)
      files.push({ path: state.path, status: state.status, hash })
    }
    return files
  }

  private async lineStat(
    dir: string,
    path: string,
    kind: GitChangeKind,
    head: string | null,
    signal: AbortSignal,
  ): Promise<GitChangedFile> {
    if (kind === 'restored') return { path, kind, addedLines: null, removedLines: null }
    const command = kind === 'created'
      ? 'diff --no-index --numstat -- /dev/null ' + quote(path)
      : 'diff ' + (head === null ? '' : 'HEAD ') + '--numstat -- ' + quote(path)
    // diff 有差异时退出码为 1，属于预期结果，照常解析 stdout。
    const result = await this.git(dir, command, signal)
    const stat = parseNumstatLine(result.stdout)
    return {
      path,
      kind,
      addedLines: stat === undefined ? null : stat.added,
      removedLines: stat === undefined ? null : stat.removed,
    }
  }

  /** 记录基线；非 Git 目录以 isRepository: false 表达，不报错。 */
  async baseline(dir: string, options?: GitProbeOptions): Promise<GitBaseline> {
    const signal = options?.signal ?? this.idleSignal
    const probe = await this.git(dir, 'rev-parse --is-inside-work-tree', signal)
    if (!probe.ok || probe.stdout.trim() !== 'true') {
      return { isRepository: false, head: null, files: [] }
    }
    const head = await this.head(dir, signal)
    const files = await this.statusFiles(dir, signal)
    return { isRepository: true, head, files }
  }

  /** 生成相对基线的只读报告。 */
  async report(dir: string, baseline: GitBaseline, options?: GitProbeOptions): Promise<GitChangeReport> {
    const signal = options?.signal ?? this.idleSignal
    if (!baseline.isRepository) {
      return {
        isRepository: false,
        head: null,
        changed: [],
        preexisting: [],
        summary: NOT_A_REPOSITORY_SUMMARY,
      }
    }

    const head = await this.head(dir, signal)
    const current = await this.statusFiles(dir, signal)
    const before = new Map(baseline.files.map(file => [file.path, file]))
    const after = new Map(current.map(file => [file.path, file]))
    const changed: GitChangedFile[] = []
    const preexisting: string[] = []

    for (const [path, state] of after) {
      const previous = before.get(path)
      if (previous === undefined || previous.hash !== state.hash || previous.status !== state.status) {
        changed.push(await this.lineStat(dir, path, kindOf(state), head, signal))
      } else {
        preexisting.push(path)
      }
    }
    for (const [path] of before) {
      if (!after.has(path)) {
        // 基线是脏的、现在干净了：本次运行把它恢复成提交状态。
        changed.push({ path, kind: 'restored', addedLines: null, removedLines: null })
      }
    }

    changed.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    preexisting.sort()

    return {
      isRepository: true,
      head,
      changed,
      preexisting,
      summary: renderChangeSummary(head, changed, preexisting),
    }
  }
}
