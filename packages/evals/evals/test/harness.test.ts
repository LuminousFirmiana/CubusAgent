import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ScriptedAdapter } from '@cubus/llm'
import { SessionLogFile } from '@cubus/session-jsonl'
import { LocalSubprocess } from '@cubus/tools'
import { runRepairTask } from '../src/harness.ts'

// fixture 是"永远带 bug"的原样仓库；每次任务在它的临时副本上跑
const fixtureDir = join(import.meta.dirname, '..', 'fixtures', 'bug-repos', 'add-bug')

let dir: string

function makeIdGen() {
  let n = 0
  return () => 'id' + String(++n)
}

async function copyFixture(): Promise<string> {
  const target = join(dir, 'repo')
  await cp(fixtureDir, target, { recursive: true })
  return target
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-evals-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('fixture sanity: the bug repo really fails before any fix', async () => {
  const repo = await copyFixture()
  const result = await new LocalSubprocess().run('node --test test/', {
    cwd: repo,
    signal: new AbortController().signal,
  })
  expect(result.exitCode).not.toBe(0)
})

test('scripted repair agent fixes the bug and passes scoring', async () => {
  const repo = await copyFixture()
  const scenes = [
    { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/math.ts' } }] } }] },
    { steps: [{ chunk: { toolCalls: [{ id: 'c2', name: 'edit_file', args: { path: 'src/math.ts', old_string: 'a - b', new_string: 'a + b' } }] } }] },
    { steps: [{ chunk: { toolCalls: [{ id: 'c3', name: 'bash', args: { command: 'node --test test/' } }] } }] },
    { steps: [{ chunk: { delta: '已修复：add 函数从减法改为加法，测试通过。' } }] },
  ]

  const result = await runRepairTask({
    repoDir: repo,
    sessionsDir: dir,
    adapterFactory: () => new ScriptedAdapter(scenes),
    generateId: makeIdGen(),
  })

  expect(result.passed).toBe(true)
  expect(result.assistantText).toBe('已修复：add 函数从减法改为加法，测试通过。')
  expect(result.turnEvents.filter(e => e.type === 'step/start')).toHaveLength(4)

  // 会话日志留存（golden trajectory）：可读、完整
  const log = new SessionLogFile(result.logPath)
  const { events, truncated } = await log.read()
  expect(truncated).toBe(false)
  expect(events.filter(e => e.type === 'tool/call').map(e => e.name)).toEqual(['read_file', 'edit_file', 'bash'])
})

test('a do-nothing agent fails scoring (the judge catches non-repairs)', async () => {
  const repo = await copyFixture()
  const result = await runRepairTask({
    repoDir: repo,
    sessionsDir: dir,
    adapterFactory: () => new ScriptedAdapter([{ steps: [{ chunk: { delta: '我什么都没做。' } }] }]),
    generateId: makeIdGen(),
  })

  expect(result.passed).toBe(false)
})
