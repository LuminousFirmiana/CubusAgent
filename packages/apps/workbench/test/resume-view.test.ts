import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { codingAgentRecipe } from '@cubus/recipe-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { SESSION_FORMAT_VERSION } from '@cubus/session'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import type { AgentRecipe } from '@cubus/agent-recipe'
import { startWorkbenchServer } from '../src/server.ts'
import type { WorkbenchServer } from '../src/server.ts'

/**
 * E6：恢复视图。
 *
 * 验收三件事：
 * 1. 崩溃留下的会话（本进程没打开过）**能看**：事件流退化为磁盘回放；
 * 2. 恢复后**能继续**：结算事件出现在响应里，会话变成可实时订阅；
 * 3. 恢复被拒时**说清楚原因**（装配不一致 / 格式版本过高），而不是一句"失败"。
 */
let dir: string
let workspace: string
let sessions: string
let server: WorkbenchServer | undefined

const scenes = [{ steps: [{ chunk: { delta: '完成' } }] }]

function makeRuntime(recipe: AgentRecipe<void> = codingAgentRecipe): SessionRuntime<void> {
  return new SessionRuntime({
    rootDir: sessions,
    host: withToolApprovalHost(
      createLocalAgentHost({ workspaceDir: workspace, adapterFactory: () => new ScriptedAdapter(scenes) }),
      createStaticToolApproval('allow', 'resume view test'),
    ),
    recipe,
    recipeOptions: undefined,
    permissionProfile: 'allow',
    generateId: () => 'rs1',
  })
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-resume-view-'))
  workspace = join(dir, 'workspace')
  sessions = join(dir, 'sessions')
  await mkdir(workspace, { recursive: true })
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(dir, { recursive: true, force: true })
})

/** 造一个崩溃现场：跑完一轮后删掉最后一条事件（turn/end）。 */
async function crashLastSession(): Promise<string> {
  const runtime = makeRuntime()
  server = await startWorkbenchServer({ runtime, workspaceDir: workspace }, { port: 0 })
  await fetch(server.url + '/api/sessions', { method: 'POST' })
  await fetch(server.url + '/api/sessions/rs1/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: '做点什么' }),
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const detail = (await (await fetch(server.url + '/api/sessions/rs1')).json()) as { run: { finishedAt?: string } | null }
    if (detail.run?.finishedAt !== undefined) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  await server.close()
  server = undefined

  const logPath = join(sessions, 'rs1', 'session.jsonl')
  const raw = await readFile(logPath, 'utf8')
  await writeFile(logPath, raw.trim().split('\n').slice(0, -1).join('\n') + '\n', 'utf8')
  return logPath
}

test('a crashed session can be read from disk and then resumed into a live session', async () => {
  await crashLastSession()

  // 新的工作台进程：这个会话没有打开过，事件流退化为磁盘回放（看得到历史，末尾有说明）
  server = await startWorkbenchServer({ runtime: makeRuntime(), workspaceDir: workspace }, { port: 0 })
  const summary = (await (await fetch(server.url + '/api/sessions/rs1')).json()) as {
    summary: { needsSettlement: boolean; lastEventType?: string }
  }
  expect(summary.summary.needsSettlement).toBe(true)

  const replayed = await fetch(server.url + '/api/sessions/rs1/events')
  const text = await replayed.text()
  expect(text).toContain('"turn/start"')
  expect(text).toContain('replay-only (session is not open; POST /resume to continue it)')

  // 恢复：结算事件出现在响应里，会话变成可实时订阅
  const resumed = (await (await fetch(server.url + '/api/sessions/rs1/resume', { method: 'POST' })).json()) as {
    settled: boolean
    settlementEvents: { type: string; settled?: true }[]
    formatVersion: number
  }
  // 用常量而不是字面量：格式版本会随词汇表增长（F4b 起是 3）
  expect(resumed.formatVersion).toBe(SESSION_FORMAT_VERSION)
  expect(resumed.settled).toBe(true)
  expect(resumed.settlementEvents.at(-1)).toMatchObject({ type: 'turn/end', settled: true })

  // 恢复后：未闭合标记消失，事件流不再是 replay-only
  const after = (await (await fetch(server.url + '/api/sessions/rs1')).json()) as {
    summary: { needsSettlement: boolean }
  }
  expect(after.summary.needsSettlement).toBe(false)

  const live = await fetch(server.url + '/api/sessions/rs1/events')
  expect(live.headers.get('content-type')).toContain('text/event-stream')
  const reader = live.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let frames = ''
  const deadline = Date.now() + 5_000
  while (reader && Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    frames += buffer
    if (buffer.includes('"turn/end"')) break
  }
  await reader?.cancel()
  // 回放里能看到结算后的闭合（settled 标记一路传到界面）
  expect(frames).toContain('"settled":true')
})

test('a refused resume explains the difference instead of failing silently', async () => {
  await crashLastSession()

  // 换一个 recipe（装配身份不同）来恢复 -> 409 + 差异说明
  const otherRecipe: AgentRecipe<void> = {
    ...codingAgentRecipe,
    manifest: { ...codingAgentRecipe.manifest, id: 'not-the-same-agent' },
  }
  server = await startWorkbenchServer({ runtime: makeRuntime(otherRecipe), workspaceDir: workspace }, { port: 0 })
  const response = await fetch(server.url + '/api/sessions/rs1/resume', { method: 'POST' })
  expect(response.status).toBe(409)
  const body = (await response.json()) as { error: string }
  expect(body.error).toContain('differs from the recorded one')
  expect(body.error).toContain('recipe: coding-agent@')
  expect(body.error).toContain('not-the-same-agent@')
  expect(body.error).toContain('start a new session instead of silently changing the environment')
})

test('the page carries the resume wiring (button, settlement markers, error text)', async () => {
  server = await startWorkbenchServer({ runtime: makeRuntime(), workspaceDir: workspace }, { port: 0 })
  const js = await (await fetch(server.url + '/app.js')).text()
  expect(js).toContain("fetch('/api/sessions/' + id + '/resume'")
  expect(js).toContain('恢复补写')
  expect(js).toContain("marker('无法恢复 ' + id + '：' + body.error, 'error')")
})
