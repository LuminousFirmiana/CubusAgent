import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import {
  assertSlug,
  loadSubagentDefinitions,
  nodeGitRunner,
  parseSubagentDefinition,
  spawnSubagent,
  WorktreeError,
  WorktreeManager,
} from '../src/index.ts'
import type { DefinitionFileIO } from '../src/index.ts'

function fakeIO(files: Record<string, string>): DefinitionFileIO {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join('/'))
  }
  return {
    async readText(path) {
      const content = files[path]
      if (content === undefined) throw new Error('ENOENT: no such file or directory, open ' + path)
      return content
    },
    async readDir(path) {
      const prefix = path + '/'
      return [...new Set(Object.keys(files).filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split('/')[0] ?? ''))].filter(entry => entry !== '')
    },
    async isDirectory(path) {
      return dirs.has(path)
    },
  }
}

const definition = (name: string, description: string, extra = ''): string =>
  '---\nname: ' + name + '\ndescription: ' + description + '\n' + extra + '---\n\n你是 ' + name + '。\n'

test('definitions parse strictly: description required, unknown keys rejected', () => {
  expect(parseSubagentDefinition(definition('reviewer', '只读的代码审查者', 'tools: read_file, bash\n'), 'x'))
    .toEqual({ name: 'reviewer', description: '只读的代码审查者', tools: ['read_file', 'bash'] })

  expect(() => parseSubagentDefinition('---\nname: a\n---\n', 'x')).toThrow('non-empty description')
  expect(() => parseSubagentDefinition('---\ndescription: a\nowner: me\n---\n', 'x')).toThrow('unknown frontmatter key')
  expect(() => parseSubagentDefinition('---\ndescription: a\nisolation: sandbox\n---\n', 'x')).toThrow('isolation must be worktree or shared')
  expect(() => parseSubagentDefinition('没有 frontmatter', 'x')).toThrow('missing frontmatter')
})

test('definitions load from directories and flat files; a missing dir is normal', async () => {
  const io = fakeIO({
    '.cubus/agents/reviewer/AGENT.md': definition('reviewer', '代码审查者'),
    '.cubus/agents/explore.md': definition('explore', '探索者', 'isolation: shared\n'),
  })
  const loaded = await loadSubagentDefinitions({ io, dir: '.cubus/agents' })
  expect(loaded.definitions.map(entry => entry.name).sort()).toEqual(['explore', 'reviewer'])
  expect(loaded.definitions.find(entry => entry.name === 'explore')?.isolation).toBe('shared')
  expect(loaded.definitions[0]?.sha256).toHaveLength(64)

  const empty = await loadSubagentDefinitions({ io: fakeIO({}), dir: '.cubus/agents' })
  expect(empty.definitions).toEqual([])
})

test('slugs are validated: injection attempts are rejected', () => {
  expect(() => assertSlug('fix-auth')).not.toThrow()
  for (const bad of ['../etc', 'Fix-Auth', 'a b', '', 'a'.repeat(60), '/abs', 'x;rm -rf /']) {
    expect(() => assertSlug(bad), bad).toThrow(WorktreeError)
  }
})

/** 真 git 仓库（worktree 是 git 行为，假实现测不出价值）。 */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cubus-wt-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], { cwd: dir })
  return dir
}

test('worktrees are created, reused, committed on their own branch, and protected from removal', async () => {
  const repo = tempRepo()
  const manager = new WorktreeManager({
    repositoryDir: repo,
    worktreesDir: join(mkdtempSync(join(tmpdir(), 'cubus-wt-out-')), 'trees'),
    git: nodeGitRunner(spawn),
  })
  expect(await manager.isGitRepository()).toBe(true)

  const created = await manager.create('fix-auth')
  expect(created.reused).toBe(false)
  expect(created.branch).toBe('cubus/fix-auth')
  // 文件隔离：worktree 里改文件，主仓库不受影响
  writeFileSync(join(created.path, 'a.txt'), 'changed in worktree\n')
  expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('hello\n')

  // 再次创建：复用，不重复 add
  const again = await manager.create('fix-auth')
  expect(again.reused).toBe(true)

  // 未提交改动：删除必须显式 discard（防误删）
  await expect(manager.remove('fix-auth')).rejects.toThrow('refusing to remove worktree')

  // 提交到自己的分支
  const committed = await manager.commit(created, 'subagent: fix auth')
  expect(committed.files).toEqual(['a.txt'])
  expect(committed.commit).toHaveLength(12)

  // 提交后再删：允许
  await manager.remove('fix-auth')
  expect(await manager.list()).toHaveLength(1)
}, 60_000)

test('spawnSubagent returns the JSON contract from a child process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cubus-sub-'))
  const resultPath = join(dir, 'result.json')
  const runnerPath = join(dir, 'fake-runner.mjs')
  writeFileSync(runnerPath, [
    "import { writeFileSync } from 'node:fs'",
    "const args = process.argv.slice(2)",
    "const result = args[args.indexOf('--result') + 1]",
    "writeFileSync(result, JSON.stringify({ ok: true, id: 'sa-test', sessionId: 's1', summary: 'done', changedFiles: ['a.txt'] }))",
  ].join('\n'), 'utf8')

  const result = await spawnSubagent({
    id: 'sa-test', task: 'do it', cwd: dir, resultPath, agent: 'worker', runnerPath,
  })
  expect(result.ok).toBe(true)
  expect(result.summary).toBe('done')
  expect(result.changedFiles).toEqual(['a.txt'])
  expect(result.exitCode).toBe(0)
})

test('a crashed child reports ok:false with stderr instead of vanishing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cubus-sub-'))
  const runnerPath = join(dir, 'crash-runner.mjs')
  writeFileSync(runnerPath, "console.error('boom: missing config'); process.exit(3)\n", 'utf8')

  const result = await spawnSubagent({
    id: 'sa-crash', task: 'x', cwd: dir, resultPath: join(dir, 'none.json'), agent: 'worker', runnerPath,
  })
  expect(result.ok).toBe(false)
  expect(result.exitCode).toBe(3)
  expect(result.summary).toContain('no result file')
  expect(result.stderrTail).toContain('boom')
})
