import { expect, test } from 'vitest'
import { createInteractiveToolApproval } from '@cubus/tool-approval'
import type { ApprovalEvent } from '@cubus/tool-approval'
import { ScriptedAdapter } from '@cubus/llm'
import { codingAgentRecipe } from '@cubus/recipe-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { withToolApprovalHost } from '@cubus/tool-approval'
import { createLocalAgentHost } from '@cubus/host-local'
import { startWorkbenchServer } from '../src/server.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

/**
 * E5：审批交互（ask 档）。
 *
 * 这里验证的是**端到端的行为**：agent 要调工具 -> 页面上出现待回答项 ->
 * 回答 allow/deny/不回答 -> 工具结果与日志里的文案相应变化。
 */
let dir: string
let workspace: string
let sessions: string
let closeServer: (() => Promise<void>) | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-approval-'))
  workspace = join(dir, 'workspace')
  sessions = join(dir, 'sessions')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'note.txt'), 'hello\n', 'utf8')
})

afterEach(async () => {
  await closeServer?.()
  closeServer = undefined
  await rm(dir, { recursive: true, force: true })
})

const toolCallScenes = [
  { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'note.txt' } }] } }] },
  { steps: [{ chunk: { delta: '看完了。' } }] },
]

async function startAsk(timeoutMs = 5_000) {
  const approval = createInteractiveToolApproval({ profile: 'ask', timeoutMs })
  const runtime = new SessionRuntime({
    rootDir: sessions,
    host: withToolApprovalHost(
      createLocalAgentHost({ workspaceDir: workspace, adapterFactory: () => new ScriptedAdapter(toolCallScenes) }),
      approval,
    ),
    recipe: codingAgentRecipe,
    recipeOptions: undefined,
    permissionProfile: 'ask',
    generateId: () => 'ap1',
  })
  const server = await startWorkbenchServer({ runtime, workspaceDir: workspace, approval }, { port: 0 })
  closeServer = server.close
  return { server, approval }
}

async function runTask(server: { url: string }): Promise<void> {
  await fetch(server.url + '/api/sessions', { method: 'POST' })
  await fetch(server.url + '/api/sessions/ap1/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: '看一下 note.txt' }),
  })
}

/** 等一个待回答的审批出现（同时验证 SSE 控制帧与列表视图）。 */
async function waitForPending(server: { url: string }, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetch(server.url + '/api/approvals')
    if (response.ok) {
      const payload = (await response.json()) as { pending: { id: string; toolName: string }[] }
      if (payload.pending.length > 0) return payload.pending[0]!
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('no pending approval appeared')
}

async function toolResultText(server: { url: string }, callId: string): Promise<string> {
  const detail = await fetch(server.url + '/api/sessions/ap1')
  void detail
  // 直接读日志投影：审批结果是 tool/result
  const events = await fetch(server.url + '/api/sessions/ap1/events')
  const reader = events.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (const block of buffer.split('\n\n')) {
      const dataLine = block.split('\n').find(line => line.startsWith('data: '))
      if (dataLine === undefined) continue
      const event = JSON.parse(dataLine.slice(6)) as { type?: string; id?: string; output?: { text?: string } }
      if (event.type === 'tool/result' && event.id === callId) {
        text = event.output?.text ?? ''
        await reader.cancel()
        return text
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2)
  }
  return text
}

test('an asked tool call runs once the page allows it', async () => {
  const { server } = await startAsk()
  const events: ApprovalEvent[] = []
  await runTask(server)

  const pending = await waitForPending(server)
  expect(pending.toolName).toBe('read_file')

  const response = await fetch(server.url + '/api/approvals/' + pending.id, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'allow' }),
  })
  expect(response.status).toBe(200)
  const resolved = (await response.json()) as { outcome: string; by: string }
  expect(resolved).toMatchObject({ outcome: 'allow', by: 'user' })

  // 工具真的执行了：结果里是文件内容，不是拒绝
  const text = await toolResultText(server, 'c1')
  expect(text).toContain('hello')
  expect(text).not.toContain('denied')
  void events
})

test('a denied tool call is recorded as denied, distinct from an execution failure', async () => {
  const { server } = await startAsk()
  await runTask(server)
  const pending = await waitForPending(server)

  await fetch(server.url + '/api/approvals/' + pending.id, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'deny' }),
  })

  const text = await toolResultText(server, 'c1')
  expect(text).toContain('tool denied by approval policy: read_file')
  expect(text).toContain('the user rejected this tool call')
  // 与"批准了但执行失败"文案区分
  expect(text).not.toContain('approved but execution failed')
})

test('an unanswered tool call is denied by default when the timeout fires', async () => {
  const { server } = await startAsk(60)
  await runTask(server)

  const text = await (async () => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const current = await toolResultText(server, 'c1')
      if (current !== '') return current
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return ''
  })()

  expect(text).toContain('tool denied by approval policy: read_file')
  expect(text).toContain('timeout: no answer within 60ms')
  // 超时后没有待回答项残留
  const payload = (await (await fetch(server.url + '/api/approvals')).json()) as { pending: unknown[] }
  expect(payload.pending).toEqual([])
})

test('answering an unknown approval is a 404, and a static workbench refuses the API', async () => {
  const { server } = await startAsk()
  const unknown = await fetch(server.url + '/api/approvals/nope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'allow' }),
  })
  expect(unknown.status).toBe(404)
  expect(((await unknown.json()) as { error: string }).error).toContain('unknown or already answered approval')

  const badBody = await fetch(server.url + '/api/approvals/whatever', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'maybe' }),
  })
  expect(badBody.status).toBe(400)

  // 静态档（没有交互式审批）时明确拒绝，而不是假装没有待回答项
  const staticRuntime = new SessionRuntime({
    rootDir: sessions,
    host: createLocalAgentHost({ workspaceDir: workspace, adapterFactory: () => new ScriptedAdapter(toolCallScenes) }),
    recipe: codingAgentRecipe,
    recipeOptions: undefined,
    permissionProfile: 'allow',
  })
  const staticServer = await startWorkbenchServer({ runtime: staticRuntime, workspaceDir: workspace }, { port: 0 })
  const refused = await fetch(staticServer.url + '/api/approvals')
  expect(refused.status).toBe(409)
  expect(((await refused.json()) as { error: string }).error).toContain('static approval policy')
  await staticServer.close()
})
