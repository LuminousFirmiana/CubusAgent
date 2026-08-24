import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SessionLogCorruptionError, SessionLogFile } from '../src/log.ts'
import type { SessionEvent } from '../src/types.ts'

let dir: string
let logPath: string

function ev(type: SessionEvent['type'], extra: Record<string, unknown> = {}): SessionEvent {
  return { type, ...extra } as SessionEvent
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-session-'))
  logPath = join(dir, 'session.jsonl')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('roundtrip: appended events read back byte-for-byte identical', async () => {
  const log = new SessionLogFile(logPath)
  const events: SessionEvent[] = [
    ev('turn/start', { turnId: 't1' }),
    ev('step/start', { stepId: 's1', turnId: 't1' }),
    ev('user/message', { messageId: 'm1', content: [{ type: 'text', text: '修一个 bug' }] }),
    ev('assistant/chunk', { stepId: 's1', delta: '我来' }),
    ev('assistant/chunk', { stepId: 's1', delta: '看看' }),
    ev('assistant/message', { messageId: 'm2', stepId: 's1', content: [{ type: 'text', text: '我来看看' }] }),
    ev('tool/call', { id: 'c1', stepId: 's1', name: 'read_file', args: { path: 'a.ts' } }),
    ev('tool/result', { id: 'c1', ok: true, output: { text: '文件内容' } }),
    ev('step/end', { stepId: 's1' }),
    ev('turn/end', { turnId: 't1' }),
  ]

  for (const event of events) await log.append(event)

  const { events: readBack, truncated } = await log.read()
  expect(truncated).toBe(false)
  expect(readBack).toEqual(events)
})

test('crash truncation: a half-written final line is dropped and reported', async () => {
  const log = new SessionLogFile(logPath)
  await log.append(ev('turn/start', { turnId: 't1' }))
  await log.append(ev('turn/end', { turnId: 't1' }))

  // 模拟进程在写入中途被杀：文件末尾留下半行 JSON
  const raw = await readFile(logPath, 'utf8')
  await writeFile(logPath, raw + '{"type":"user/mess', 'utf8')

  const { events, truncated } = await log.read()
  expect(truncated).toBe(true)
  expect(events).toHaveLength(2)
})

test('corruption: a bad line in the middle throws with its line number', async () => {
  const log = new SessionLogFile(logPath)
  await log.append(ev('turn/start', { turnId: 't1' }))

  const raw = await readFile(logPath, 'utf8')
  await writeFile(logPath, raw + 'this is not json\n' + JSON.stringify(ev('turn/end', { turnId: 't1' })) + '\n', 'utf8')

  await expect(log.read()).rejects.toThrow(SessionLogCorruptionError)
  await expect(log.read()).rejects.toThrow('line 2')
})

test('append continues: old events survive, new events join them', async () => {
  const log = new SessionLogFile(logPath)
  await log.append(ev('turn/start', { turnId: 't1' }))

  await log.append(ev('turn/end', { turnId: 't1' }))

  const { events } = await log.read()
  expect(events).toHaveLength(2)
  expect(events[0]).toEqual(ev('turn/start', { turnId: 't1' }))
  expect(events[1]).toEqual(ev('turn/end', { turnId: 't1' }))
})

test('missing file reads as an empty log, not an error', async () => {
  const log = new SessionLogFile(logPath)
  const { events, truncated } = await log.read()
  expect(events).toEqual([])
  expect(truncated).toBe(false)
})

