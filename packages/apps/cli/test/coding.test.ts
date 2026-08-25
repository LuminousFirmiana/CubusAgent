import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScriptedAdapter } from '@cubus/llm'
import { SessionLogFile } from '@cubus/session-jsonl'
import {
  CliUsageError,
  parseCodingCommand,
  renderCodingResult,
  runCodingCommand,
} from '../src/index.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-cli-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('parses the explicit trusted-workspace command surface', () => {
  expect(parseCodingCommand([
    '--workspace', './repo',
    '--task', 'fix tests',
    '--trust-workspace',
    '--sessions-dir', './sessions',
  ])).toEqual({
    help: false,
    options: {
      workspace: './repo',
      task: 'fix tests',
      trustWorkspace: true,
      approval: 'ask',
      maxModelAttempts: 3,
      sessionsDir: './sessions',
    },
  })
  expect(() => parseCodingCommand(['--workspace', './repo'])).toThrow('coding requires --task')
  expect(() => parseCodingCommand(['--unknown'])).toThrow('unknown option')
  expect(() => parseCodingCommand([
    '--workspace', './repo', '--task', 'x', '--max-model-attempts', '0',
  ])).toThrow('--max-model-attempts must be an integer from 1 to 10')
})

test('refuses an untrusted workspace before preparing any model or tool provider', async () => {
  let prepared = false
  await expect(runCodingCommand({
    workspace: dir,
    task: 'do not run',
    trustWorkspace: false,
  }, {
    async prepareAdapterFactory() {
      prepared = true
      return () => new ScriptedAdapter([])
    },
  })).rejects.toThrow(CliUsageError)
  expect(prepared).toBe(false)
})

test('runs the formal Coding Agent Recipe against a trusted workspace and preserves the log', async () => {
  const workspace = join(dir, 'repo')
  const sessionsDir = join(dir, 'sessions')
  await mkdir(workspace)
  await writeFile(join(workspace, 'note.txt'), 'before\n', 'utf8')
  const scenes = [
    { steps: [{ chunk: { toolCalls: [{
      id: 'edit-1',
      name: 'edit_file',
      args: { path: 'note.txt', old_string: 'before', new_string: 'after' },
    }] } }] },
    { steps: [{ chunk: { delta: 'Updated note.txt.' } }] },
  ]

  const result = await runCodingCommand({
    workspace,
    task: 'Update the note.',
    trustWorkspace: true,
    approval: 'allow',
    sessionsDir,
  }, {
    adapterFactory: () => new ScriptedAdapter(scenes),
    generateId: () => 'session-1',
  })

  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('after\n')
  expect(result.assistantText).toBe('Updated note.txt.')
  expect(result.logPath).toBe(join(await realpath(sessionsDir), 'session-1', 'session.jsonl'))
  const { events, truncated } = await new SessionLogFile(result.logPath).read()
  expect(truncated).toBe(false)
  expect(events.find(event => event.type === 'request/header')?.header.tools?.map(tool => tool.name)).toEqual([
    'bash',
    'edit_file',
    'read_file',
    'write_file',
  ])
  expect(events.find(event => event.type === 'user/message')?.content[0]?.text).toBe('Update the note.')

  const lines: string[] = []
  renderCodingResult(result, { write: line => lines.push(line) })
  expect(lines).toContain('tool edit-1: ok - edited note.txt (1 replacement)')
  expect(lines).toContain('assistant: Updated note.txt.')
})

test('deny mode records the refusal, does not mutate the workspace, and lets the model close the turn', async () => {
  const workspace = join(dir, 'denied-repo')
  const sessionsDir = join(dir, 'denied-sessions')
  await mkdir(workspace)
  await writeFile(join(workspace, 'note.txt'), 'before\n', 'utf8')
  const result = await runCodingCommand({
    workspace,
    task: 'Try to update the note.',
    trustWorkspace: true,
    approval: 'deny',
    sessionsDir,
  }, {
    adapterFactory: () => new ScriptedAdapter([
      { steps: [{ chunk: { toolCalls: [{
        id: 'denied-1',
        name: 'edit_file',
        args: { path: 'note.txt', old_string: 'before', new_string: 'after' },
      }] } }] },
      { steps: [{ chunk: { delta: 'The edit was denied.' } }] },
    ]),
    generateId: () => 'denied-session',
  })

  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('before\n')
  expect(result.assistantText).toBe('The edit was denied.')
  expect(result.turnEvents.find(event => event.type === 'tool/result')).toMatchObject({
    type: 'tool/result',
    id: 'denied-1',
    ok: false,
    output: { text: 'tool denied by approval policy: edit_file (CLI deny mode)' },
  })
})

test('an abort signal cancels an active bash tool and returns the settled session log', async () => {
  const workspace = join(dir, 'cancelled-repo')
  const sessionsDir = join(dir, 'cancelled-sessions')
  const readyPath = join(workspace, 'ready.txt')
  await mkdir(workspace)
  const script = [
    `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
    'setInterval(() => {}, 1000)',
  ].join(';')
  const controller = new AbortController()
  const operation = runCodingCommand({
    workspace,
    task: 'Run until cancelled.',
    trustWorkspace: true,
    approval: 'allow',
    sessionsDir,
  }, {
    adapterFactory: () => new ScriptedAdapter([{ steps: [{ chunk: { toolCalls: [{
      id: 'bash-1',
      name: 'bash',
      args: { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` },
    }] } }] }]),
    generateId: () => 'cancelled-session',
    signal: controller.signal,
  })

  await vi.waitFor(async () => {
    const ready = await readFile(readyPath, 'utf8').catch(() => undefined)
    expect(ready).toBe('ready')
  })
  controller.abort(new Error('cancel command'))
  const result = await operation

  expect(result.cancelled).toBe(true)
  expect(result.turnEvents.find(event => event.type === 'tool/result')).toMatchObject({
    id: 'bash-1',
    ok: false,
    output: { text: 'cancelled' },
  })
  expect(result.turnEvents.at(-1)?.type).toBe('turn/end')
  const lines: string[] = []
  renderCodingResult(result, { write: line => lines.push(line) })
  expect(lines).toContain('status: cancelled')
})

test('refuses to place the session fact source inside the tool-writable workspace', async () => {
  const workspace = join(dir, 'repo')
  await mkdir(workspace)
  let adapterCreated = false

  await expect(runCodingCommand({
    workspace,
    task: 'do not run',
    trustWorkspace: true,
    sessionsDir: join(workspace, '.cubus', 'sessions'),
  }, {
    adapterFactory() {
      adapterCreated = true
      return new ScriptedAdapter([])
    },
  })).rejects.toThrow('sessions directory must be outside')
  expect(adapterCreated).toBe(false)
})
