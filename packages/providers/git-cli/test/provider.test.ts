import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { LocalSubprocess } from '@cubus/tools'
import { GitCliWorkspaceProvider, NOT_A_REPOSITORY_SUMMARY } from '../src/index.ts'

let dir: string
const subprocess = new LocalSubprocess()
const provider = new GitCliWorkspaceProvider(subprocess)
/** 测试里的 git 命令不参与取消；用常驻信号满足 seam 的必填参数。 */
const idleSignal = new AbortController().signal

async function exec(cwd: string, command: string): Promise<string> {
  const result = await subprocess.run(command, { cwd, signal: idleSignal, timeoutMs: 30_000 })
  if (result.exitCode !== 0) {
    throw new Error('command failed: ' + command + ' :: ' + result.stdout + result.stderr)
  }
  return result.stdout
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await exec(path, 'git init -q -b main')
  await exec(path, 'git config user.email cubus@example.com')
  await exec(path, 'git config user.name Cubus Test')
  await exec(path, 'git config commit.gpgsign false')
  await exec(path, 'git config core.hooksPath /dev/null')
}

async function commitAll(path: string, message: string): Promise<void> {
  await exec(path, 'git add -A')
  await exec(path, 'git -c commit.gpgsign=false commit -q -m ' + JSON.stringify(message))
}

/** 标准种子仓库：src/app.ts（1 行）与 note.txt（2 行）已提交。 */
async function seedRepo(path: string): Promise<void> {
  await initRepo(path)
  await mkdir(join(path, 'src'), { recursive: true })
  await writeFile(join(path, 'src', 'app.ts'), 'export const value = 1\n', 'utf8')
  await writeFile(join(path, 'note.txt'), 'note-a\nnote-b\n', 'utf8')
  await commitAll(path, 'init')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-git-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('reports a clean repository with no changes', async () => {
  const repo = join(dir, 'clean')
  await seedRepo(repo)

  const baseline = await provider.baseline(repo)
  expect(baseline.isRepository).toBe(true)
  expect(baseline.head).toMatch(/^[0-9a-f]{40}$/)
  expect(baseline.files).toEqual([])

  const report = await provider.report(repo, baseline)
  expect(report.changed).toEqual([])
  expect(report.preexisting).toEqual([])
  expect(report.summary).toBe('git: repository at HEAD ' + String(baseline.head).slice(0, 7) + '\nchanged: 0')
})

test('preserves the boundary of pre-existing user changes', async () => {
  const repo = join(dir, 'dirty')
  await seedRepo(repo)
  await writeFile(join(repo, 'note.txt'), 'user edit\n', 'utf8')

  const baseline = await provider.baseline(repo)
  expect(baseline.files.map(file => file.path)).toEqual(['note.txt'])

  const report = await provider.report(repo, baseline)
  expect(report.changed).toEqual([])
  expect(report.preexisting).toEqual(['note.txt'])
  expect(report.summary).toContain('preexisting (not touched by this run): 1')
  expect(report.summary).toContain('  note.txt')
})

test('lists files the agent created, modified, and deleted with line counts', async () => {
  const repo = join(dir, 'work')
  await seedRepo(repo)
  const baseline = await provider.baseline(repo)

  await writeFile(join(repo, 'new.txt'), 'one\ntwo\nthree\n', 'utf8')
  await writeFile(join(repo, 'src', 'app.ts'), 'export const value = 2\n', 'utf8')
  await unlink(join(repo, 'note.txt'))

  const report = await provider.report(repo, baseline)
  expect(report.changed).toEqual([
    { path: 'new.txt', kind: 'created', addedLines: 3, removedLines: 0 },
    { path: 'note.txt', kind: 'deleted', addedLines: 0, removedLines: 2 },
    { path: 'src/app.ts', kind: 'modified', addedLines: 1, removedLines: 1 },
  ])
  expect(report.preexisting).toEqual([])
  expect(report.summary).toContain('changed: 3')
  expect(report.summary).toContain('  created new.txt (+3/-0)')
  expect(report.summary).toContain('  deleted note.txt (+0/-2)')
  expect(report.summary).toContain('  modified src/app.ts (+1/-1)')
})

test('detects agent edits to a file that was already dirty', async () => {
  const repo = join(dir, 'dirty-again')
  await seedRepo(repo)
  await writeFile(join(repo, 'note.txt'), 'user edit\n', 'utf8')
  const baseline = await provider.baseline(repo)

  await writeFile(join(repo, 'note.txt'), 'user edit then agent edit\n', 'utf8')

  const report = await provider.report(repo, baseline)
  // 分类按基线哈希判定（这个文件被动过）；行数相对 HEAD：
  // 提交时是两行，现在是一行 -> +1/-2（含用户既有改动，见 seam 文档）。
  expect(report.preexisting).toEqual([])
  expect(report.changed).toEqual([
    { path: 'note.txt', kind: 'modified', addedLines: 1, removedLines: 2 },
  ])
})

test('reports a file restored to the committed state as restored', async () => {
  const repo = join(dir, 'restored')
  await seedRepo(repo)
  await writeFile(join(repo, 'note.txt'), 'user edit\n', 'utf8')
  const baseline = await provider.baseline(repo)

  await exec(repo, 'git checkout -- note.txt')

  const report = await provider.report(repo, baseline)
  expect(report.changed).toEqual([
    { path: 'note.txt', kind: 'restored', addedLines: null, removedLines: null },
  ])
})

test('reports a non-git directory without failing', async () => {
  const plain = join(dir, 'plain')
  await mkdir(plain)

  const baseline = await provider.baseline(plain)
  expect(baseline).toEqual({ isRepository: false, head: null, files: [] })

  const report = await provider.report(plain, baseline)
  expect(report).toMatchObject({ isRepository: false, changed: [], preexisting: [] })
  expect(report.summary).toBe(NOT_A_REPOSITORY_SUMMARY)
})

test('is read-only: HEAD, index, worktree state and commit count are unchanged', async () => {
  const repo = join(dir, 'readonly')
  await seedRepo(repo)
  await writeFile(join(repo, 'note.txt'), 'user edit\n', 'utf8')

  const baseline = await provider.baseline(repo)
  const statusBefore = await exec(repo, 'git status --porcelain=v1 -uall')
  const headBefore = await exec(repo, 'git rev-parse HEAD')
  const indexBefore = await exec(repo, 'git diff --cached --name-only')
  const logBefore = await exec(repo, 'git log --oneline')

  await provider.report(repo, baseline)

  expect(await exec(repo, 'git status --porcelain=v1 -uall')).toBe(statusBefore)
  expect(await exec(repo, 'git rev-parse HEAD')).toBe(headBefore)
  expect(await exec(repo, 'git diff --cached --name-only')).toBe(indexBefore)
  expect(await exec(repo, 'git log --oneline')).toBe(logBefore)
})

test('reports an empty repository (no commits yet) without failing', async () => {
  const repo = join(dir, 'empty')
  await initRepo(repo)

  // 先记录基线（此时仓库完全空），再产生 agent 改动。
  const baseline = await provider.baseline(repo)
  expect(baseline).toMatchObject({ isRepository: true, head: null, files: [] })
  await writeFile(join(repo, 'new.txt'), 'one\n', 'utf8')

  const report = await provider.report(repo, baseline)
  expect(report.head).toBe(null)
  expect(report.changed).toEqual([
    { path: 'new.txt', kind: 'created', addedLines: 1, removedLines: 0 },
  ])
  expect(report.summary).toContain('HEAD (no commits)')
})
