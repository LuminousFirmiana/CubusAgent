import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import type { SessionEvent } from '@cubus/session'
import { jsonlSessionPlugin, SessionLogCorruptionError, SessionLogFile } from '../src/index.ts'

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
    ev('request/header', {
      stepId: 's1',
      header: { provider: 'deepseek', model: 'deepseek-chat', systemPrompt: '修复问题' },
    }),
    ev('assistant/chunk', { stepId: 's1', delta: '我来' }),
    ev('assistant/chunk', { stepId: 's1', thinkingDelta: '先检查' }),
    ev('assistant/message', {
      messageId: 'm2',
      stepId: 's1',
      content: [{ type: 'text', text: '我来看看' }],
      thinking: '先检查',
    }),
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

test('append continues and a missing file reads as an empty log', async () => {
  const log = new SessionLogFile(logPath)
  expect(await log.read()).toEqual({ events: [], truncated: false })

  await log.append(ev('turn/start', { turnId: 't1' }))
  await log.append(ev('turn/end', { turnId: 't1' }))

  const { events } = await log.read()
  expect(events).toEqual([
    ev('turn/start', { turnId: 't1' }),
    ev('turn/end', { turnId: 't1' }),
  ])
})

test('provider lifecycle exposes and removes the session seam', async () => {
  const ctx = new Context()
  const provider = ctx.plugin(jsonlSessionPlugin, { path: logPath })
  await provider

  expect(ctx.get('sessionLog')).toBeInstanceOf(SessionLogFile)

  await provider.dispose()
  expect(ctx.get('sessionLog')).toBeUndefined()
})
