import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { parseArchiveCommand, renderPrunePlan } from '../src/archive.ts'
import { main as archiveMain } from '../src/archive.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('the command line picks exactly one mode and validates its arguments', () => {
  expect(parseArchiveCommand(['--export', '/tmp/out'], '/tmp/sessions'))
    .toMatchObject({ mode: 'export', path: '/tmp/out', sessionsDir: '/tmp/sessions', rename: false, yes: false })
  // pnpm run 会把 -- 原样传进来
  expect(parseArchiveCommand(['--', '--import', '/tmp/in', '--rename'], '/tmp/sessions'))
    .toMatchObject({ mode: 'import', rename: true })
  expect(parseArchiveCommand(['--prune', '--older-than-days', '7', '--include-crashed', '--yes'], '/tmp/sessions'))
    .toMatchObject({ mode: 'prune', olderThanDays: 7, keepNeedingSettlement: false, yes: true })
  expect(parseArchiveCommand(['--export', '/tmp/out', '--session', 'a', '--session', 'b'], '/tmp/sessions').sessionIds)
    .toEqual(['a', 'b'])

  expect(() => parseArchiveCommand([], '/tmp/sessions')).toThrow('pick one of --export <dir> / --import <dir> / --prune')
  expect(() => parseArchiveCommand(['--export', '/tmp/out', '--prune'], '/tmp/sessions'))
    .toThrow('pick exactly one of --export / --import / --prune')
  expect(() => parseArchiveCommand(['--export'], '/tmp/sessions')).toThrow('--export requires a value')
  expect(() => parseArchiveCommand(['--prune'], undefined))
    .toThrow('no sessions directory: pass --sessions <dir> or set "sessionsDir" in ~/.cubus/config.json')
  expect(() => parseArchiveCommand(['--prune', '--older-than-days', '-1'], '/tmp/sessions'))
    .toThrow('--older-than-days must be a non-negative integer')
  expect(() => parseArchiveCommand(['--nope'], '/tmp/sessions')).toThrow('unknown option: --nope')
})

test('the prune report lists absolute paths and says whether anything will be deleted', () => {
  const plan = { remove: ['s1'], keep: [{ id: 's2', reason: 'needs settlement (crashed session)' }] }
  const dry = renderPrunePlan(plan, '/tmp/sessions', false)
  expect(dry).toContain('sessions dir: /tmp/sessions')
  expect(dry).toContain('/tmp/sessions/s1')
  expect(dry).toContain('s2  (needs settlement (crashed session))')
  expect(dry).toContain('dry run: nothing was deleted (pass --yes to delete)')
  expect(renderPrunePlan(plan, '/tmp/sessions', true)).toContain('deleting (--yes was given)')
})

test('export then prune --yes round-trips through the CLI entry point', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-archive-cli-'))
  directories.push(root)
  const sessions = join(root, 'sessions')
  const session = join(sessions, 'demo')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(session, { recursive: true })
  await writeFile(join(session, 'session.meta.json'), '{"formatVersion":3,"sessionId":"demo"}\n', 'utf8')
  await writeFile(
    join(session, 'session.jsonl'),
    JSON.stringify({ type: 'turn/start', turnId: 't1', at: '2026-01-01T00:00:00.000Z' }) + '\n' +
    JSON.stringify({ type: 'turn/end', turnId: 't1', at: '2026-01-01T00:00:02.000Z' }) + '\n',
    'utf8',
  )

  const archiveDir = join(root, 'backup')
  expect(await archiveMain(['--sessions', sessions, '--export', archiveDir])).toBe(0)
  expect(JSON.parse(await readFile(join(archiveDir, 'manifest.json'), 'utf8'))).toMatchObject({ version: 1 })

  // 第一次：dry run（只打印计划）
  expect(await archiveMain(['--sessions', sessions, '--prune', '--older-than-days', '0'])).toBe(0)
  await expect(readFile(join(session, 'session.jsonl'), 'utf8')).resolves.toBeTruthy()

  // 第二次：--yes 真删（这个会话已闭合，不在保留名单里）
  expect(await archiveMain(['--sessions', sessions, '--prune', '--older-than-days', '0', '--yes'])).toBe(0)
  await expect(readFile(join(session, 'session.jsonl'), 'utf8')).rejects.toThrow()

  // 导入回来
  expect(await archiveMain(['--sessions', sessions, '--import', archiveDir])).toBe(0)
  await expect(readFile(join(session, 'session.jsonl'), 'utf8')).resolves.toContain('turn/end')
})
