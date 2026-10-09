import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ScriptedAdapter } from '@cubus/llm'
import { SessionLogFile } from '@cubus/session-jsonl'
import { LocalSubprocess } from '@cubus/tools'
import {
  CliUsageError,
  parseCodingCommand,
  renderCodingResult,
  runCodingCommand,
} from '../src/index.ts'

let dir: string

const gitSubprocess = new LocalSubprocess()
/** 测试里的 git 命令不参与取消；用常驻信号满足 seam 的必填参数。 */
const idleSignal = new AbortController().signal

async function gitExec(cwd: string, command: string): Promise<void> {
  const result = await gitSubprocess.run(command, { cwd, signal: idleSignal, timeoutMs: 30_000 })
  if (result.exitCode !== 0) {
    throw new Error('git command failed: ' + command + ' :: ' + result.stdout + result.stderr)
  }
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await gitExec(path, 'git init -q -b main')
  await gitExec(path, 'git config user.email cubus@example.com')
  await gitExec(path, 'git config user.name Cubus Test')
  await gitExec(path, 'git config commit.gpgsign false')
  await gitExec(path, 'git config core.hooksPath /dev/null')
}

async function commitAll(path: string, message: string): Promise<void> {
  await gitExec(path, 'git add -A')
  await gitExec(path, 'git -c commit.gpgsign=false commit -q -m ' + JSON.stringify(message))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

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

test('reports the files this run changed relative to the git baseline', async () => {
  const workspace = join(dir, 'git-repo')
  const sessionsDir = join(dir, 'git-sessions')
  await initRepo(workspace)
  await writeFile(join(workspace, 'note.txt'), 'before\n', 'utf8')
  await commitAll(workspace, 'init')

  const result = await runCodingCommand({
    workspace,
    task: 'Update the note and add a file.',
    trustWorkspace: true,
    approval: 'allow',
    sessionsDir,
  }, {
    adapterFactory: () => new ScriptedAdapter([
      { steps: [{ chunk: { toolCalls: [
        { id: 'edit-1', name: 'edit_file', args: { path: 'note.txt', old_string: 'before', new_string: 'after' } },
      ] } }] },
      { steps: [{ chunk: { toolCalls: [
        { id: 'write-1', name: 'write_file', args: { path: 'extra.txt', content: 'a\nb\n' } },
      ] } }] },
      { steps: [{ chunk: { delta: 'Done.' } }] },
    ]),
    generateId: () => 'git-session',
  })

  expect(result.changes.isRepository).toBe(true)
  expect(result.changes.changed).toEqual([
    { path: 'extra.txt', kind: 'created', addedLines: 2, removedLines: 0 },
    { path: 'note.txt', kind: 'modified', addedLines: 1, removedLines: 1 },
  ])
  expect(result.changes.preexisting).toEqual([])

  const lines: string[] = []
  renderCodingResult(result, { write: line => lines.push(line) })
  expect(lines).toContain('changed: 2')
  expect(lines).toContain('  created extra.txt (+2/-0)')
  expect(lines).toContain('  modified note.txt (+1/-1)')
})

test('keeps pre-existing user edits out of the run report', async () => {
  const workspace = join(dir, 'git-dirty-repo')
  const sessionsDir = join(dir, 'git-dirty-sessions')
  await initRepo(workspace)
  await writeFile(join(workspace, 'note.txt'), 'committed\n', 'utf8')
  await writeFile(join(workspace, 'target.txt'), 'one\n', 'utf8')
  await commitAll(workspace, 'init')
  // 用户在运行前就改了 note.txt，但从未提交
  await writeFile(join(workspace, 'note.txt'), 'user edit\n', 'utf8')

  const result = await runCodingCommand({
    workspace,
    task: 'Only touch target.txt.',
    trustWorkspace: true,
    approval: 'allow',
    sessionsDir,
  }, {
    adapterFactory: () => new ScriptedAdapter([
      { steps: [{ chunk: { toolCalls: [
        { id: 'edit-1', name: 'edit_file', args: { path: 'target.txt', old_string: 'one', new_string: 'two' } },
      ] } }] },
      { steps: [{ chunk: { delta: 'Only target.txt changed.' } }] },
    ]),
    generateId: () => 'git-dirty-session',
  })

  expect(result.changes.preexisting).toEqual(['note.txt'])
  expect(result.changes.changed).toEqual([
    { path: 'target.txt', kind: 'modified', addedLines: 1, removedLines: 1 },
  ])

  const lines: string[] = []
  renderCodingResult(result, { write: line => lines.push(line) })
  expect(lines).toContain('preexisting (not touched by this run): 1')
  expect(lines).toContain('  note.txt')
})

test('reports a non-git workspace without failing the run', async () => {
  const workspace = join(dir, 'plain-repo')
  const sessionsDir = join(dir, 'plain-sessions')
  await mkdir(workspace)

  const result = await runCodingCommand({
    workspace,
    task: 'Nothing to do.',
    trustWorkspace: true,
    approval: 'allow',
    sessionsDir,
  }, {
    adapterFactory: () => new ScriptedAdapter([{ steps: [{ chunk: { delta: 'Done.' } }] }]),
    generateId: () => 'plain-session',
  })

  expect(result.changes).toMatchObject({ isRepository: false, changed: [], preexisting: [] })

  const lines: string[] = []
  renderCodingResult(result, { write: line => lines.push(line) })
  expect(lines).toContain('git: not a repository')
})

test('streams model text and tool cards live while the run is still in flight', async () => {
  const workspace = join(dir, 'live-repo')
  const sessionsDir = join(dir, 'live-sessions')
  await mkdir(workspace)
  await writeFile(join(workspace, 'note.txt'), 'before\n', 'utf8')
  const gate = deferred()
  const lines: string[] = []

  const operation = runCodingCommand({
    workspace,
    task: 'Update the note.',
    trustWorkspace: true,
    approval: 'allow',
    sessionsDir,
  }, {
    output: { write: line => lines.push(line) },
    adapterFactory: () => new ScriptedAdapter([
      { steps: [
        { chunk: { delta: 'starting\n' }, hold: gate.promise },
        { chunk: { toolCalls: [
          { id: 'edit-1', name: 'edit_file', args: { path: 'note.txt', old_string: 'before', new_string: 'after' } },
        ] } },
      ] },
      { steps: [{ chunk: { delta: 'done' } }] },
    ]),
    generateId: () => 'live-session',
  })

  // 模型流被 hold 卡住：此刻已经出现实时输出，说明是流式而不是结束后的汇总。
  await vi.waitFor(() => expect(lines).toContain('  starting'))
  expect(lines.some(line => line.startsWith('assistant:'))).toBe(false)

  gate.resolve()
  const result = await operation

  expect(lines).toContain('→ edit_file note.txt')
  expect(lines).toContain('← ok edited note.txt (1 replacement)')
  expect(lines).toContain('  done')
  expect(result.assistantText).toBe('done')

  renderCodingResult(result, { write: line => lines.push(line) })
  expect(lines).toContain('assistant: done')
})
