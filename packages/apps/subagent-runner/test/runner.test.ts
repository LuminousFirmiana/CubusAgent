import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { spawnSubagent } from '@cubus/subagents'

const runnerPath = join(import.meta.dirname, '..', 'src', 'main.ts')

test('the runner starts an independent session in a child process and writes the contract', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cubus-runner-ws-'))
  writeFileSync(join(workspace, 'note.txt'), 'hello\n')
  const sessions = mkdtempSync(join(tmpdir(), 'cubus-runner-sessions-'))
  const result = await spawnSubagent({
    id: 'sa-runner',
    task: '用一句话说明这个工作区里有什么',
    cwd: workspace,
    resultPath: join(workspace, '.result.json'),
    agent: 'worker',
    runnerPath,
    env: { CUBUS_SUBAGENT_FAKE: '1', CUBUS_SUBAGENT_SESSIONS: sessions },
    timeoutMs: 120_000,
  })

  expect(result.ok).toBe(true)
  expect(result.sessionId).toBeDefined()
  // 子会话有独立日志：父只拿到 sessionId 指针
  const events = readFileSync(join(sessions, String(result.sessionId), 'session.jsonl'), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line) as { type: string })
  expect(events[0]?.type).toBe('session/mount')
  expect(events.some(event => event.type === 'request/header')).toBe(true)
  expect(result.stats?.steps ?? 0).toBeGreaterThan(0)
}, 180_000)

test('a bogus runner path fails closed with a result, not a hang', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cubus-runner-ws-'))
  const result = await spawnSubagent({
    id: 'sa-bogus',
    task: 'x',
    cwd: workspace,
    resultPath: join(workspace, '.result.json'),
    agent: 'worker',
    runnerPath: join(workspace, 'missing-runner.ts'),
    timeoutMs: 30_000,
  })
  expect(result.ok).toBe(false)
  expect(result.summary).toContain('no result file')
}, 60_000)