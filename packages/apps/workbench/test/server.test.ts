import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { codingAgentRecipe } from '@cubus/recipe-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import { startWorkbenchServer } from '../src/server.ts'
import type { WorkbenchServer } from '../src/server.ts'

let dir: string
let workspace: string
let sessions: string
let server: WorkbenchServer | undefined

function makeIdGen() {
  let n = 0
  return () => 'wb' + String(++n)
}

/** 工作台测试用的运行时接线：与 CLI/评测同构（Host + 静态审批 + 产品 recipe）。 */
function makeRuntime(scenes: ConstructorParameters<typeof ScriptedAdapter>[0]): SessionRuntime<void> {
  return new SessionRuntime({
    rootDir: sessions,
    host: withToolApprovalHost(
      createLocalAgentHost({ workspaceDir: workspace, adapterFactory: () => new ScriptedAdapter(scenes) }),
      createStaticToolApproval('allow', 'workbench test'),
    ),
    recipe: codingAgentRecipe,
    recipeOptions: undefined,
    permissionProfile: 'allow',
    generateId: makeIdGen(),
  })
}

const scenes = [
  { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'note.txt' } }] } }] },
  { steps: [{ chunk: { delta: '看完了。' } }] },
]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-workbench-'))
  workspace = join(dir, 'workspace')
  sessions = join(dir, 'sessions')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'note.txt'), 'hello\n', 'utf8')
})

afterEach(async () => {
  await server?.close()
  server = undefined
  await rm(dir, { recursive: true, force: true })
})

async function start(runtime = makeRuntime(scenes)): Promise<{ server: WorkbenchServer; runtime: SessionRuntime<void> }> {
  server = await startWorkbenchServer({ runtime }, { port: 0 })
  return { server, runtime }
}

/** 读取 SSE 响应，直到 predicate 满足或超时（工作台的事件流验收）。 */
async function readStream(
  url: string,
  predicate: (frames: { event: string; data: unknown }[]) => boolean,
  timeoutMs = 10_000,
): Promise<{ event: string; data: unknown }[]> {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('no response body')

  const decoder = new TextDecoder()
  const frames: { event: string; data: unknown }[] = []
  const deadline = Date.now() + timeoutMs
  let buffer = ''
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const eventLine = raw.split('\n').find(line => line.startsWith('event: '))
        const dataLine = raw.split('\n').find(line => line.startsWith('data: '))
        if (eventLine === undefined || dataLine === undefined) continue
        frames.push({ event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) })
      }
      if (predicate(frames)) break
    }
  } finally {
    controller.abort()
  }
  return frames
}

test('create, run and observe a session: events stream live and the log stays the source of truth', async () => {
  const { server: wb } = await start()

  const created = await fetch(wb.url + '/api/sessions', { method: 'POST' })
  expect(created.status).toBe(201)
  const { session } = (await created.json()) as { session: { id: string; logPath: string } }
  expect(session.id).toBe('wb1')

  // 先订阅（SSE 会先回放日志，再推实时事件），再发起运行
  const streamPromise = readStream(wb.url + '/api/sessions/' + session.id + '/events', frames =>
    frames.some(frame => frame.event === 'run-state' && (frame.data as { running: boolean }).running === false),
  )

  const started = await fetch(wb.url + '/api/sessions/' + session.id + '/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: '看一下 note.txt' }),
  })
  expect(started.status).toBe(202)

  const frames = await streamPromise
  const eventTypes = frames
    .filter(frame => frame.event === 'session-event')
    .map(frame => (frame.data as { type: string }).type)
  // 实时流里能看到完整的回合骨架
  expect(eventTypes).toContain('session/mount')
  expect(eventTypes).toContain('tool/call')
  expect(eventTypes).toContain('tool/result')
  expect(eventTypes).toContain('turn/end')
  const lastFrame = frames.at(-1)
  expect(lastFrame?.event).toBe('run-state')
  expect((lastFrame?.data as { assistantText?: string } | undefined)?.assistantText).toBe('看完了。')

  // 详情：装配快照 + 预算 + 运行状态，全部来自既有能力
  const detail = (await (await fetch(wb.url + '/api/sessions/' + session.id)).json()) as {
    summary: { eventCount: number; needsSettlement: boolean; recipe?: { id: string } }
    snapshot: { capabilities: { kind: string }[]; permission: { profile: string; source: string } }
    budget: { steps: number }
    run: { finishedAt?: string }
  }
  expect(detail.summary.recipe?.id).toBe('coding-agent')
  expect(detail.summary.needsSettlement).toBe(false)
  expect(detail.snapshot.permission).toEqual({ profile: 'allow', source: 'app' })
  expect(detail.snapshot.capabilities.map(capability => capability.kind)).toContain('sandbox')
  expect(detail.budget.steps).toBeGreaterThan(0)
  expect(detail.run.finishedAt).toBeDefined()

  // 列表与并发视图
  const list = (await (await fetch(wb.url + '/api/sessions')).json()) as { sessions: { id: string }[] }
  expect(list.sessions.map(entry => entry.id)).toEqual(['wb1'])
  const concurrency = (await (await fetch(wb.url + '/api/concurrency')).json()) as {
    concurrency: { active: number; queued: number; limit: number }
  }
  expect(concurrency.concurrency).toMatchObject({ active: 0, queued: 0, limit: 4 })
})

/** 读取 SSE 响应，保留每条帧的 id（Last-Event-ID 续传的验收靠它）。 */
async function readIndexedStream(
  url: string,
  predicate: (frames: { event: string; data: unknown; id?: number }[]) => boolean,
  options: { lastEventId?: number; timeoutMs?: number } = {},
): Promise<{ event: string; data: unknown; id?: number }[]> {
  const controller = new AbortController()
  const headers: Record<string, string> = {}
  if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId)
  const response = await fetch(url, { headers, signal: controller.signal })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('no response body')

  const decoder = new TextDecoder()
  const frames: { event: string; data: unknown; id?: number }[] = []
  const deadline = Date.now() + (options.timeoutMs ?? 10_000)
  let buffer = ''
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const lines = raw.split('\n')
        const eventLine = lines.find(line => line.startsWith('event: '))
        const dataLine = lines.find(line => line.startsWith('data: '))
        const idLine = lines.find(line => line.startsWith('id: '))
        if (eventLine === undefined || dataLine === undefined) continue
        frames.push({
          event: eventLine.slice(7),
          data: JSON.parse(dataLine.slice(6)),
          ...(idLine === undefined ? {} : { id: Number(idLine.slice(4)) }),
        })
      }
      if (predicate(frames)) break
    }
  } finally {
    controller.abort()
  }
  return frames
}

test('event frames carry log indexes and a reconnect resumes with Last-Event-ID: no loss, no duplicates', async () => {
  const { server: wb } = await start()
  await fetch(wb.url + '/api/sessions', { method: 'POST' })
  await fetch(wb.url + '/api/sessions/wb1/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: '看一下 note.txt' }),
  })

  // 第一次连接：读到回合闭合（日志里的 turn/end），记录每条事件帧的 id。
  // 注意：控制帧（run-state）是短暂的、不落盘的；连得晚的客户端从日志与详情里取状态。
  const first = await readIndexedStream(wb.url + '/api/sessions/wb1/events', frames =>
    frames.some(frame =>
      frame.event === 'session-event' && (frame.data as { type?: string }).type === 'turn/end',
    ),
  )
  const firstIds = first.filter(frame => frame.event === 'session-event').map(frame => frame.id)
  expect(firstIds.length).toBeGreaterThan(5)
  // 下标连续且从 0 开始：它是日志里的位置
  expect(firstIds).toEqual(firstIds.map((_, index) => index))

  // 已有的日志被完整回放到最后一帧；带 Last-Event-ID 重连时只补后面的
  const totalEvents = firstIds.length
  const resumeFrom = totalEvents - 3
  const expectedIds = Array.from({ length: totalEvents - 1 - resumeFrom }, (_, offset) => resumeFrom + 1 + offset)
  const second = await readIndexedStream(
    wb.url + '/api/sessions/wb1/events',
    frames => frames.filter(frame => frame.event === 'session-event').length >= expectedIds.length,
    { lastEventId: resumeFrom },
  )
  const secondIds = second.filter(frame => frame.event === 'session-event').map(frame => frame.id)
  // 不重：从 resumeFrom + 1 开始；不丢：把日志里剩下的都补上（日志一共 totalEvents 条，下标 0..totalEvents-1）
  expect(secondIds).toEqual(expectedIds)
}, 30_000)

test('the UI is served as static assets and the API index stays available for curl', async () => {
  const { server: wb } = await start()

  const page = await fetch(wb.url + '/')
  expect(page.headers.get('content-type')).toContain('text/html')
  const html = await page.text()
  // 页面引用脚本与工具栏是它与服务端的契约
  expect(html).toContain('<script src="/app.js">')
  expect(html).toContain('CubusAgent 工作台')
  expect(html).toContain('id="transcript"')

  const script = await fetch(wb.url + '/app.js')
  expect(script.headers.get('content-type')).toContain('text/javascript')
  const js = await script.text()
  // 靠 EventSource 订阅日志（浏览器会自动带 Last-Event-ID 续传）
  expect(js).toContain('new EventSource(')
  expect(js).toContain("source.addEventListener('session-event'")
  // 无状态原则写在代码里：前端不缓存，只按事件渲染
  expect(js).toContain('无状态原则')

  const index = await (await fetch(wb.url + '/api')).text()
  expect(index).toContain('POST /api/sessions/:id/run')
})

test('replaying the same log twice yields identical frames: refreshing renders the same thing', async () => {
  const { server: wb } = await start()
  await fetch(wb.url + '/api/sessions', { method: 'POST' })
  await fetch(wb.url + '/api/sessions/wb1/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: '看一下 note.txt' }),
  })

  const collect = async (): Promise<string[]> => {
    const frames = await readIndexedStream(wb.url + '/api/sessions/wb1/events', list =>
      list.some(frame => frame.event === 'session-event' && (frame.data as { type?: string }).type === 'turn/end'),
    )
    return frames
      .filter(frame => frame.event === 'session-event')
      .map(frame => String(frame.id) + ':' + JSON.stringify(frame.data))
  }

  // 两次独立的"打开页面"（= 两次全新连接）必须得到逐帧一致的结果 —— 界面只读日志，所以刷新等价
  const first = await collect()
  const second = await collect()
  expect(second).toEqual(first)
}, 30_000)

test('resume refuses a session whose log has no assembly snapshot, and reports the reason', async () => {
  const { server: wb } = await start()
  const legacy = join(sessions, 'legacy')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'session.jsonl'), JSON.stringify({ type: 'turn/start', turnId: 't1' }) + '\n', 'utf8')

  const response = await fetch(wb.url + '/api/sessions/legacy/resume', { method: 'POST' })
  expect(response.status).toBe(409)
  const body = (await response.json()) as { error: string }
  expect(body.error).toContain('no assembly snapshot')
})

test('input errors are reported as HTTP errors, not crashes', async () => {
  const { server: wb } = await start()
  await fetch(wb.url + '/api/sessions', { method: 'POST' })

  const missingTask = await fetch(wb.url + '/api/sessions/wb1/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(missingTask.status).toBe(400)
  expect(((await missingTask.json()) as { error: string }).error).toContain('non-empty "task"')

  const badJson = await fetch(wb.url + '/api/sessions/wb1/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  })
  expect(badJson.status).toBe(400)

  const unknown = await fetch(wb.url + '/api/sessions/ghost/events')
  expect(unknown.status).toBe(404)

  const unknownRoute = await fetch(wb.url + '/api/nope')
  expect(unknownRoute.status).toBe(404)

  // 索引列出端点（人能 curl 得清楚）；根路径是界面
  const index = await (await fetch(wb.url + '/api')).text()
  expect(index).toContain('POST /api/sessions/:id/run')
})

test('a crashed session can be resumed through the workbench and the settlement is streamed', async () => {
  const { server: wb } = await start()
  await fetch(wb.url + '/api/sessions', { method: 'POST' })
  await fetch(wb.url + '/api/sessions/wb1/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: '看一下 note.txt' }),
  })
  // 等运行结束（轮询详情里的 run.finishedAt）
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const detail = (await (await fetch(wb.url + '/api/sessions/wb1')).json()) as { run: { finishedAt?: string } | null }
    if (detail.run?.finishedAt !== undefined) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  // 造一个"崩溃尾巴"：删掉最后一条事件（turn/end）
  const logPath = join(sessions, 'wb1', 'session.jsonl')
  const raw = await readFile(logPath, 'utf8')
  await writeFile(logPath, raw.trim().split('\n').slice(0, -1).join('\n') + '\n', 'utf8')

  const summary = (await (await fetch(wb.url + '/api/sessions/wb1')).json()) as {
    summary: { needsSettlement: boolean }
  }
  expect(summary.summary.needsSettlement).toBe(true)

  // 换个新运行时（模拟进程重启后工作台重新打开同一目录）
  await server?.close()
  // 同一个会话 id：新的运行时会重新装配（校验身份一致）并结算崩溃尾巴
  const resumedRuntime = new SessionRuntime({
    rootDir: sessions,
    host: withToolApprovalHost(
      createLocalAgentHost({ workspaceDir: workspace, adapterFactory: () => new ScriptedAdapter([{ steps: [{ chunk: { delta: '恢复后继续' } }] }]) }),
      createStaticToolApproval('allow', 'workbench test'),
    ),
    recipe: codingAgentRecipe,
    recipeOptions: undefined,
    permissionProfile: 'allow',
  })
  server = await startWorkbenchServer({ runtime: resumedRuntime }, { port: 0 })

  const resumed = await fetch(server.url + '/api/sessions/wb1/resume', { method: 'POST' })
  expect(resumed.status).toBe(200)
  const body = (await resumed.json()) as { settled: boolean; settlementEvents: { type: string; settled?: true }[] }
  expect(body.settled).toBe(true)
  expect(body.settlementEvents.at(-1)).toMatchObject({ type: 'turn/end', settled: true })
})
