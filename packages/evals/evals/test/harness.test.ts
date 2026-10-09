import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ScriptedAdapter } from '@cubus/llm'
import { SessionLogFile } from '@cubus/session-jsonl'
import { LocalSubprocess } from '@cubus/tools'
import { compareFingerprints } from '../src/fingerprint.ts'
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

  // 行为指纹（D4）：工具序列 + 工作区文件集都从真实来源算出来
  expect(result.fingerprint.judge).toBe('pass')
  expect(result.fingerprint.tools).toEqual(['read_file', 'edit_file', 'bash'])
  expect(result.fingerprint.files).toEqual([{ path: 'src/math.ts', kind: 'modified' }])
  // 流式碎片与装配快照不进指纹
  expect(result.fingerprint.events).not.toContain('assistant/chunk')
  expect(result.fingerprint.events).not.toContain('session/mount')
  expect(result.fingerprint.events).toContain('tool/result:edit_file:ok')
})

test('the gate goes red when behaviour degrades (the self-proving test)', async () => {
  // golden：读 -> 改 -> 验证（正常修复）
  const good = await runRepairTask({
    repoDir: await copyFixture(),
    sessionsDir: dir,
    adapterFactory: () => new ScriptedAdapter([
      { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/math.ts' } }] } }] },
      { steps: [{ chunk: { toolCalls: [{ id: 'c2', name: 'edit_file', args: { path: 'src/math.ts', old_string: 'a - b', new_string: 'a + b' } }] } }] },
      { steps: [{ chunk: { toolCalls: [{ id: 'c3', name: 'bash', args: { command: 'node --test test/' } }] } }] },
      { steps: [{ chunk: { delta: '修好了。' } }] },
    ]),
    generateId: makeIdGen(),
  })
  expect(good.passed).toBe(true)

  // 退化行为：修复正确、判分通过，但**顺手留下了一个多余文件**（范围蔓延）。
  // 这正是 guardrails 要抓的东西：判分管不到"越界改动"，文件集管得到。
  const degraded = await runRepairTask({
    repoDir: await copyFixture(),
    sessionsDir: join(dir, 'degraded-sessions'),
    adapterFactory: () => new ScriptedAdapter([
      { steps: [{ chunk: { toolCalls: [{ id: 'd1', name: 'read_file', args: { path: 'src/math.ts' } }] } }] },
      { steps: [{ chunk: { toolCalls: [{ id: 'd2', name: 'write_file', args: { path: 'debug-notes.md', content: '排查记录' } }] } }] },
      { steps: [{ chunk: { toolCalls: [{ id: 'd3', name: 'edit_file', args: { path: 'src/math.ts', old_string: 'a - b', new_string: 'a + b' } }] } }] },
      { steps: [{ chunk: { toolCalls: [{ id: 'd4', name: 'bash', args: { command: 'node --test test/' } }] } }] },
      { steps: [{ chunk: { delta: '修好了，顺便留了个排查记录。' } }] },
    ]),
    generateId: makeIdGen(),
  })

  // 判分过了（bug 确实修好了），但门禁必须红：改动的文件集与 golden 不一致
  expect(degraded.passed).toBe(true)
  const comparison = compareFingerprints(good.fingerprint, degraded.fingerprint)
  expect(comparison.ok).toBe(false)
  expect(comparison.differences.join(' ')).toContain('extra [debug-notes.md:created]')

  // 同样的行为面对同一条 golden 是绿的（门禁不误报）
  expect(compareFingerprints(good.fingerprint, good.fingerprint).ok).toBe(true)
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
