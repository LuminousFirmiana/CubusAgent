import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { AssemblyMismatchError } from '@cubus/agent-recipe'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import {
  deriveMessages,
  parseSessionMeta,
  SessionFormatError,
  SESSION_FORMAT_VERSION,
  UNKNOWN_TOOL_RESULT_TEXT,
} from '@cubus/session'
import type { SessionEvent } from '@cubus/session'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import { createTools } from '@cubus/tools'
import { SessionRuntime } from '../src/runner.ts'
import type { AgentRecipe } from '@cubus/agent-recipe'

const directories: string[] = []
const children: ReturnType<typeof spawn>[] = []
const packageRoot = join(import.meta.dirname, '..')

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function makeIdGen(prefix: string) {
  let n = 0
  return () => prefix + String(++n)
}

async function readEvents(logPath: string): Promise<SessionEvent[]> {
  const raw = await readFile(logPath, 'utf8')
  return raw.trim().split('\n').filter(line => line !== '').map(line => JSON.parse(line) as SessionEvent)
}

function runtimeFor(rootDir: string, workspaceDir: string, scenes: ConstructorParameters<typeof ScriptedAdapter>[0], recipe = testRecipe) {
  return new SessionRuntime({
    rootDir,
    host: createLocalAgentHost({ workspaceDir, adapterFactory: () => new ScriptedAdapter(scenes) }),
    recipe,
    recipeOptions: undefined,
    generateId: makeIdGen('r'),
  })
}

const testRecipe: AgentRecipe<void> = {
  manifest: {
    contractVersion: 1,
    id: 'resume-test',
    version: '1.0.0',
    displayName: 'Resume Test Agent',
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      { kind: 'fs', features: ['read', 'write'] },
      { kind: 'subprocess' },
    ],
    prompt: { fragmentId: 'resume-test/role' },
    tools: ['read_file', 'edit_file', 'write_file', 'bash'],
    permission: { profile: 'allow' },
  },
  async mount(ctx) {
    await ctx.plugin(systemPromptContribution({ id: 'resume-test/role', text: 'Resume test agent.' }))
    const fs = ctx.get('fs')
    const subprocess = ctx.get('subprocess')
    const workspace = ctx.get('workspaceDir')
    if (!fs || !subprocess || !workspace) throw new Error('missing host capabilities')
    for (const tool of createTools(fs, subprocess, workspace)) {
      await ctx.plugin(toolContribution(tool))
    }
  },
}

/**
 * 与 examples/crash-session.ts 同一身份的 recipe：
 * 恢复要求装配身份一致（recipe id/version、能力、权限档、预算），这正是 D1 §5.3 的规则。
 */
const crashDemoRecipe: AgentRecipe<void> = {
  ...testRecipe,
  manifest: { ...testRecipe.manifest, id: 'crash-demo' },
}

test('create writes a format-version sidecar next to the log', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-resume-'))
  directories.push(root)
  const runtime = runtimeFor(root, root, [{ steps: [{ chunk: { delta: 'ok' } }] }])
  const session = await runtime.create()

  const meta = parseSessionMeta(await readFile(join(dirname(session.logPath), 'session.meta.json'), 'utf8'))
  expect(meta).toMatchObject({
    formatVersion: SESSION_FORMAT_VERSION,
    sessionId: session.id,
    recipe: { id: 'resume-test', version: '1.0.0' },
  })
  expect(meta.createdAt).toBeTypeOf('string')
})

test('resume settles a crash mid-tool: unknown result, step and turn closure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-resume-'))
  directories.push(root)
  const logs = join(root, 'sessions')

  // 先正常跑一轮，然后把日志截断成"崩在工具调用中间"的样子
  const first = runtimeFor(logs, root, [
    { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'true' } }] } }] },
    { steps: [{ chunk: { delta: 'done' } }] },
  ])
  const session = await first.create()
  await first.run(session.id, 'do it')
  const events = await readEvents(session.logPath)
  const callIndex = events.findIndex(event => event.type === 'tool/call')
  const truncated = events.slice(0, callIndex + 1) // 留下 tool/call，去掉结果与所有闭合
  await writeFile(session.logPath, truncated.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')

  // 新运行时恢复同一目录
  const second = runtimeFor(logs, root, [{ steps: [{ chunk: { delta: 'resumed' } }] }])
  const resumed = await second.resume({ directory: dirname(session.logPath), id: session.id })

  expect(resumed.formatVersion).toBe(SESSION_FORMAT_VERSION)
  expect(resumed.settled).toBe(true)
  expect(resumed.settlementEvents).toContainEqual({
    type: 'tool/result',
    id: 'c1',
    ok: false,
    output: { text: UNKNOWN_TOOL_RESULT_TEXT },
  })
  expect(resumed.settlementEvents.at(-1)).toMatchObject({ type: 'turn/end', settled: true })

  // 恢复后继续跑一轮：投影里每个 tool_call 都必须有配对（否则 provider 会报错）
  const run = await second.run(session.id, 'continue')
  expect(run.assistantText).toBe('resumed')
  const after = await readEvents(session.logPath)
  const callIds = after.filter(event => event.type === 'tool/call').map(event => event.id)
  const resultIds = new Set(after.filter(event => event.type === 'tool/result').map(event => event.id))
  for (const id of callIds) expect(resultIds.has(id)).toBe(true)
  // 而且只写了一条装配快照（不变量：唯一且最先）
  expect(after.filter(event => event.type === 'session/mount')).toHaveLength(1)
  expect(after[0]?.type).toBe('session/mount')
  expect(deriveMessages(after).some(message => message.role === 'tool-result')).toBe(true)
})

test('resume refuses an assembly that differs from the recorded one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-resume-'))
  directories.push(root)
  const logs = join(root, 'sessions')
  const first = runtimeFor(logs, root, [{ steps: [{ chunk: { delta: 'ok' } }] }])
  const session = await first.create()
  await first.run(session.id, 'hello')

  // 换一个 recipe（身份不同）来恢复 -> 拒绝，而不是悄悄换环境
  const otherRecipe: AgentRecipe<void> = { ...testRecipe, manifest: { ...testRecipe.manifest, id: 'other-agent' } }
  const second = runtimeFor(logs, root, [{ steps: [{ chunk: { delta: 'ok' } }] }], otherRecipe)

  let caught: unknown
  try {
    await second.resume({ directory: dirname(session.logPath), id: session.id })
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(AssemblyMismatchError)
  expect((caught as Error).message).toContain('start a new session instead of silently changing the environment')
  expect((caught as AssemblyMismatchError).differences[0]).toContain('recipe: resume-test@1.0.0 -> other-agent@1.0.0')
})

test('resume refuses a newer log format and a log without an assembly snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-resume-'))
  directories.push(root)

  // 版本更高：拒绝（提示升级工具而不是降级日志）
  expect(() => parseSessionMeta('{"formatVersion":99}')).toThrow(SessionFormatError)
  expect(() => parseSessionMeta('{"formatVersion":99}')).toThrow('upgrade the tooling instead of downgrading the log')

  // 旧日志（无 sidecar、无装配快照）：明确报"无法恢复"
  const legacy = await mkdtemp(join(tmpdir(), 'cubus-resume-legacy-'))
  directories.push(legacy)
  await writeFile(join(legacy, 'session.jsonl'), JSON.stringify({ type: 'turn/start', turnId: 't1' }) + '\n', 'utf8')
  const runtime = runtimeFor(join(root, 'unused'), root, [{ steps: [{ chunk: { delta: 'ok' } }] }])

  await expect(runtime.resume({ directory: legacy })).rejects.toThrow('no assembly snapshot')
})

test('a SIGKILLed session resumes and continues through the real process path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-resume-kill-'))
  directories.push(root)
  const sessions = join(root, 'sessions')
  const workspace = join(root, 'workspace')

  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'examples/crash-session.ts'], {
    cwd: packageRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CUBUS_CRASH_SESSIONS: sessions, CUBUS_CRASH_WORKSPACE: workspace },
  })
  children.push(child)

  const stdout = child.stdout
  if (!stdout) throw new Error('failed to spawn crash demo')
  const sessionDir = await new Promise<string>((resolve, reject) => {
    const reader = createInterface({ input: stdout })
    reader.on('line', line => {
      const match = /^session-dir: (.+)$/.exec(line)
      if (match?.[1] !== undefined) {
        reader.close()
        resolve(match[1])
      }
    })
    child.once('error', reject)
    setTimeout(() => reject(new Error('crash demo did not print its session dir')), 20_000)
  })

  // 等日志里真的出现 tool/call（说明它正卡在那个工具调用里），然后断电式杀掉
  const logPath = join(sessionDir, 'session.jsonl')
  const deadline = Date.now() + 20_000
  let crashed = false
  while (Date.now() < deadline) {
    const raw = await readFile(logPath, 'utf8').catch(() => '')
    if (raw.includes('"tool/call"')) {
      child.kill('SIGKILL')
      crashed = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(crashed).toBe(true)
  // 等进程真的退出；可能已经退出，先看 exitCode，避免等一个不会再来的事件
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      child.once('exit', resolve)
      setTimeout(resolve, 10_000)
    })
  }

  // 恢复：结算 + 继续。装配身份必须与崩溃演示一致（同一 recipe id），否则会被拒绝。
  const runtime = runtimeFor(sessions, workspace, [{ steps: [{ chunk: { delta: 'recovered' } }] }], crashDemoRecipe)
  const resumed = await runtime.resume({ directory: sessionDir })
  expect(resumed.settled).toBe(true)
  expect(resumed.settlementEvents).toContainEqual(expect.objectContaining({
    type: 'tool/result',
    ok: false,
    output: { text: UNKNOWN_TOOL_RESULT_TEXT },
  }))

  const run = await runtime.run(resumed.session.id, 'are you back?')
  expect(run.assistantText).toBe('recovered')

  const events = await readEvents(logPath)
  const callIds = events.filter(event => event.type === 'tool/call').map(event => event.id)
  const resultIds = new Set(events.filter(event => event.type === 'tool/result').map(event => event.id))
  for (const id of callIds) expect(resultIds.has(id)).toBe(true)
}, 60_000)
