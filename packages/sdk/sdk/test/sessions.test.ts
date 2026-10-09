import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import { createTools } from '@cubus/tools'
import type { AgentRecipe } from '@cubus/agent-recipe'
import { listSessions, readSessionEvents, readSessionSummary } from '../src/sessions.ts'
import { SessionRuntime } from '../src/runner.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function makeIdGen(prefix: string) {
  let n = 0
  return () => prefix + String(++n)
}

const testRecipe: AgentRecipe<void> = {
  manifest: {
    contractVersion: 1,
    id: 'sessions-test',
    version: '1.0.0',
    displayName: 'Sessions Test Agent',
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      { kind: 'fs', features: ['read', 'write'] },
      { kind: 'subprocess' },
    ],
    prompt: { fragmentId: 'sessions-test/role' },
    tools: ['read_file', 'edit_file', 'write_file', 'bash'],
    permission: { profile: 'allow' },
  },
  async mount(ctx) {
    await ctx.plugin(systemPromptContribution({ id: 'sessions-test/role', text: 'Sessions test agent.' }))
    const fs = ctx.get('fs')
    const subprocess = ctx.get('subprocess')
    const workspace = ctx.get('workspaceDir')
    if (!fs || !subprocess || !workspace) throw new Error('missing host capabilities')
    for (const tool of createTools(fs, subprocess, workspace)) {
      await ctx.plugin(toolContribution(tool))
    }
  },
}

async function makeRuntime(root: string, scenes: ConstructorParameters<typeof ScriptedAdapter>[0], prefix: string) {
  return new SessionRuntime({
    rootDir: root,
    host: createLocalAgentHost({ workspaceDir: root, adapterFactory: () => new ScriptedAdapter(scenes) }),
    recipe: testRecipe,
    recipeOptions: undefined,
    generateId: makeIdGen(prefix),
  })
}

test('readSessionEvents tolerates a half-written last line but not corruption in the middle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-sessions-'))
  directories.push(root)
  const log = join(root, 'session.jsonl')
  await writeFile(log, '{"type":"turn/start","turnId":"t1"}\n{"type":"step/st', 'utf8')

  const tolerant = await readSessionEvents(log)
  expect(tolerant.events).toHaveLength(1)
  expect(tolerant.truncated).toBe(true)

  await writeFile(log, '{"type":"turn/start","turnId":"t1"}\n{broken}\n{"type":"turn/end","turnId":"t1"}\n', 'utf8')
  await expect(readSessionEvents(log)).rejects.toThrow('session log is corrupted at line 2')

  expect(await readSessionEvents(join(root, 'missing.jsonl'))).toEqual({ events: [], truncated: false })
})

test('listSessions summarises live and crashed sessions, newest first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-sessions-'))
  directories.push(root)
  const sessions = join(root, 'sessions')
  const runtime = await makeRuntime(sessions, [{ steps: [{ chunk: { delta: '完成' } }] }], 's')

  const first = await runtime.create()
  await runtime.run(first.id, '任务一')
  const second = await runtime.create()
  await runtime.run(second.id, '任务二')

  const summaries = await listSessions(sessions)
  expect(summaries.map(summary => summary.id)).toEqual(['s2', 's1'])
  for (const summary of summaries) {
    expect(summary.problems).toEqual([])
    expect(summary.formatVersion).toBe(2)
    expect(summary.recipe).toEqual({ id: 'sessions-test', version: '1.0.0' })
    expect(summary.capabilities).toContain('llm:local-adapter')
    expect(summary.permissionProfile).toBe('allow')
    expect(summary.lastEventType).toBe('turn/end')
    expect(summary.needsSettlement).toBe(false)
    expect(summary.eventCount).toBeGreaterThan(5)
  }

  // 崩溃尾巴（未闭合 turn）在摘要里被标出来 —— 工作台据此提示"可恢复"
  const logPath = join(sessions, 's2', 'session.jsonl')
  const raw = await readFile(logPath, 'utf8')
  const kept = raw.trim().split('\n').slice(0, -1).join('\n') + '\n'
  await writeFile(logPath, kept, 'utf8')
  const crashed = await readSessionSummary(join(sessions, 's2'))
  expect(crashed.needsSettlement).toBe(true)
})

test('a session whose format version is too new is reported with problems, not silently listed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-sessions-'))
  directories.push(root)
  const directory = join(root, 'future-session')
  await writeFile(join(root, 'placeholder.txt'), '', 'utf8')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.meta.json'), '{"formatVersion":99}', 'utf8')
  await writeFile(join(directory, 'session.jsonl'), '', 'utf8')

  const summary = await readSessionSummary(directory)
  expect(summary.problems.join(' ')).toContain('upgrade the tooling instead of downgrading the log')
  expect(summary.formatVersion).toBeUndefined()
  expect(summary.eventCount).toBe(0)
})

test('replay returns the live log of an open session and rejects unknown ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-sessions-'))
  directories.push(root)
  const sessions = join(root, 'sessions')
  const runtime = await makeRuntime(sessions, [{ steps: [{ chunk: { delta: '完成' } }] }], 'r')
  const session = await runtime.create()
  await runtime.run(session.id, '任务')

  const replay = await runtime.replay(session.id)
  expect(replay.truncated).toBe(false)
  expect(replay.events[0]?.type).toBe('session/mount')
  expect(replay.events.at(-1)?.type).toBe('turn/end')
  await expect(runtime.replay('nope')).rejects.toThrow('session not found: nope')
  expect(runtime.sessionsDir).toBe(sessions)
  expect(dirname(session.logPath)).toBe(join(sessions, session.id))
})
