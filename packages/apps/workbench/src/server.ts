import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AssemblyMismatchError } from '@cubus/agent-recipe'
import type { GitBaseline } from '@cubus/git'
import { GitCliWorkspaceProvider } from '@cubus/git-cli'
import { listSessions, readSessionSummary, SessionRuntime } from '@cubus/sdk'
import { LocalSubprocess } from '@cubus/tools'
import type { InteractiveApproval } from '@cubus/tool-approval'
import { SessionFormatError } from '@cubus/session'
import type { SessionEvent } from '@cubus/session'

/**
 * 工作台服务端（E1）：把 SDK 的会话能力暴露成 HTTP + SSE。
 *
 * 分工：**app 负责接线**（模型、凭据、Host、权限档、recipe），工作台只负责
 * "多会话的创建、运行、观察、恢复"。它不碰内核，也不自己造会话语义 ——
 * 所有状态都来自会话日志与 SDK 的既有能力（含 C6 的有界并发与 D3 的恢复）。
 *
 * 默认只监听 127.0.0.1：工作台是本地工具，不是公网服务。
 */

export interface WorkbenchOptions<RecipeOptions> {
  readonly runtime: SessionRuntime<RecipeOptions>
  /**
   * 被 agent 修改的工作区（E4 差异视图用）。
   * 与 Host 的工作区是同一个目录：这里只做**只读** Git 报告，复用 A1 的 provider。
   */
  readonly workspaceDir?: string
  /**
   * 交互式审批（E5）：给出时，工作台提供 GET /api/approvals 与 POST /api/approvals/:id，
   * 并把待回答项作为控制帧推给所有在线页面。审批本身由 tool-approval 包实现，工作台只做搬运。
   */
  readonly approval?: InteractiveApproval
  /** SSE 心跳间隔（毫秒）；默认 15s，0 = 关闭。 */
  readonly heartbeatMs?: number
}

export interface WorkbenchListenOptions {
  readonly port?: number
  readonly host?: string
}

export interface WorkbenchServer {
  readonly url: string
  readonly port: number
  readonly host: string
  close(): Promise<void>
}

/** 前端资源（零构建：直接读 ui/ 下的文件，路径不依赖 cwd）。 */
const assets = new Map<string, { path: string; contentType: string }>([
  ['index.html', { path: fileURLToPath(new URL('../ui/index.html', import.meta.url)), contentType: 'text/html; charset=utf-8' }],
  ['app.js', { path: fileURLToPath(new URL('../ui/app.js', import.meta.url)), contentType: 'text/javascript; charset=utf-8' }],
])

function serveAsset(res: ServerResponse, name: string, fallbackType: string): void {
  const asset = assets.get(name)
  if (asset === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + name)
    return
  }
  try {
    const body = readFileSync(asset.path)
    res.writeHead(200, { 'content-type': asset.contentType || fallbackType, 'content-length': body.length })
    res.end(body)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('cannot read asset ' + name + ': ' + messageOf(error))
  }
}

/** 带 HTTP 状态码的错误（app 自己的参数校验用）。 */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

interface RunState {
  readonly startedAt: string
  finishedAt?: string
  error?: string
  assistantText?: string
  /** 本次运行开始前的工作区基线（差异视图的参照点；只有它进内存，不缓存报告本身）。 */
  baseline?: GitBaseline
}

type Frame = { event: string; data: unknown }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 错误 -> HTTP 状态码：语义化映射，让客户端能区分"找不到""不能恢复""内部错误"。 */
function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status
  const message = messageOf(error)
  if (message.includes('session not found')) return 404
  if (message.includes('unknown or already answered approval')) return 404
  if (
    error instanceof SessionFormatError ||
    error instanceof AssemblyMismatchError ||
    message.includes('no assembly snapshot') ||
    message.includes('differs from the recorded one')
  ) {
    return 409
  }
  return 500
}

async function readJsonBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limitBytes) throw new HttpError(413, 'request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) throw new Error('expected a JSON object')
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new HttpError(400, 'invalid JSON body: ' + messageOf(error))
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export async function startWorkbenchServer<RecipeOptions>(
  options: WorkbenchOptions<RecipeOptions>,
  listen: WorkbenchListenOptions = {},
): Promise<WorkbenchServer> {
  const runtime = options.runtime
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const sessionsDir = runtime.sessionsDir
  /** 每个会话的实时订阅者（控制类帧：run 开始/结束、恢复结算）。 */
  const listeners = new Map<string, Set<(frame: Frame) => void>>()
  /** 最近一次运行的状态（跑飞/失败对客户端可见）。 */
  const runs = new Map<string, RunState>()

  function publish(sessionId: string, frame: Frame): void {
    for (const listener of listeners.get(sessionId) ?? []) {
      try {
        listener(frame)
      } catch {
        // 单个订阅者写失败不影响别人（断开的连接由它自己的 close 事件清理）
      }
    }
  }

  /** 审批事件推给**所有**在线页面：审批项不带会话归属（见 ADR §10 的已知限制）。 */
  function publishToAll(frame: Frame): void {
    for (const set of listeners.values()) {
      for (const listener of set) {
        try {
          listener(frame)
        } catch {
          // 同上：UI 的失败不影响审批
        }
      }
    }
  }

  const unsubscribeApproval = options.approval?.onEvent(event => {
    publishToAll({ event: 'approval', data: event })
  })

  // 只读 Git 报告（A1 的 provider）：与 CLI 的输出同源，不另写 diff 逻辑。
  const git = options.workspaceDir === undefined ? undefined : new GitCliWorkspaceProvider(new LocalSubprocess())

  async function startRun(sessionId: string, task: string): Promise<void> {
    const state: RunState = { startedAt: new Date().toISOString() }
    if (git !== undefined && options.workspaceDir !== undefined) {
      // 基线在运行前记录：不要求工作区干净，用户原有改动留在 preexisting 一侧
      state.baseline = await git.baseline(options.workspaceDir)
    }
    runs.set(sessionId, state)
    publish(sessionId, { event: 'run-state', data: { sessionId, running: true, startedAt: state.startedAt } })
    try {
      const result = await runtime.run(sessionId, task)
      if (result.assistantText !== undefined) state.assistantText = result.assistantText
    } catch (error) {
      state.error = messageOf(error)
    } finally {
      state.finishedAt = new Date().toISOString()
      publish(sessionId, {
        event: 'run-state',
        data: {
          sessionId,
          running: false,
          finishedAt: state.finishedAt,
          ...(state.error === undefined ? {} : { error: state.error }),
          ...(state.assistantText === undefined ? {} : { assistantText: state.assistantText }),
        },
      })
    }
  }

  /**
   * 事件流（SSE）：**不丢不重**的三步 ——
   *   1. 先读一次日志拿到基线长度 N0；
   *   2. 订阅（此后每个新事件都进缓冲），再读一次拿快照 N（N >= N0）；
   *   3. 回放快照（按 Last-Event-ID 过滤），再补发缓冲里"快照之后"的事件。
   * 每条事件帧带 `id: <日志下标>`，客户端重连时用 Last-Event-ID 续传，因此
   * 既不会丢（快照覆盖到订阅时刻之后的全部写入）也不会重（下标是 append-only 的位置）。
   */
  async function streamEvents(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const before = await runtime.replay(sessionId)
    const buffered: SessionEvent[] = []
    // 头部（回放）写好之前先缓冲；写好之后订阅回调直接写流 —— 中间不丢也不重。
    let forward: ((event: SessionEvent) => void) | undefined
    const unsubscribe = runtime.subscribe(sessionId, event => {
      if (forward === undefined) {
        buffered.push(event)
        return
      }
      forward(event)
    })

    const snapshot = await runtime.replay(sessionId)
    const lastEventId = Number(req.headers['last-event-id'] ?? '-1')
    const resumeFrom = Number.isInteger(lastEventId) && lastEventId >= 0 ? lastEventId : -1

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    let nextIndex = 0
    const writeEvent = (event: SessionEvent, isControl = false): void => {
      const id = isControl ? undefined : nextIndex++
      res.write(
        (id === undefined ? '' : 'id: ' + String(id) + '\n') +
        'event: ' + (isControl ? 'control' : 'session-event') + '\n' +
        'data: ' + JSON.stringify(event) + '\n\n',
      )
    }
    for (const [index, event] of snapshot.events.entries()) {
      if (index <= resumeFrom) nextIndex = index + 1
      if (index > resumeFrom) writeEvent(event)
    }

    // 快照之后写入的事件：缓冲里有、快照里没有的那一段
    const alreadyInSnapshot = snapshot.events.length - before.events.length
    forward = event => writeEvent(event)
    for (const event of buffered.slice(alreadyInSnapshot)) writeEvent(event)

    const write = (frame: Frame): void => {
      res.write('event: ' + frame.event + '\ndata: ' + JSON.stringify(frame.data) + '\n\n')
    }
    const set = listeners.get(sessionId) ?? new Set<(frame: Frame) => void>()
    set.add(write)
    listeners.set(sessionId, set)

    const heartbeat = heartbeatMs > 0
      ? setInterval(() => res.write(': ping\n\n'), heartbeatMs)
      : undefined
    heartbeat?.unref()

    const cleanup = (): void => {
      unsubscribe()
      set.delete(write)
      if (set.size === 0) listeners.delete(sessionId)
      if (heartbeat !== undefined) clearInterval(heartbeat)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const segments = url.pathname.split('/').filter(segment => segment !== '')
    const method = req.method ?? 'GET'

    // GET / —— 单页界面（零构建；它只读日志与 API，自己不保存状态）
    if (method === 'GET' && segments.length === 0) {
      serveAsset(res, 'index.html', 'text/html; charset=utf-8')
      return
    }
    if (method === 'GET' && segments.length === 1 && segments[0] === 'app.js') {
      serveAsset(res, 'app.js', 'text/javascript; charset=utf-8')
      return
    }

    // GET /api —— 端点清单（人在终端里 curl 得清楚）
    if (method === 'GET' && segments.length === 1 && segments[0] === 'api') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end([
        'CubusAgent workbench (API only)',
        '',
        'GET  /api/concurrency',
        'GET  /api/approvals                待回答的审批（ask 档）',
        'POST /api/approvals/:id            {"decision":"allow"|"deny"}',
        'GET  /api/sessions',
        'POST /api/sessions',
        'GET  /api/sessions/:id',
        'POST /api/sessions/:id/run        {"task": "..."}',
        'GET  /api/sessions/:id/events     (SSE)',
        'GET  /api/sessions/:id/changes    本次运行改了什么（只读 Git 报告）',
        'POST /api/sessions/:id/resume',
        '',
      ].join('\n'))
      return
    }

    if (method === 'GET' && segments[0] === 'api' && segments[1] === 'concurrency' && segments.length === 2) {
      sendJson(res, 200, { concurrency: runtime.concurrency() })
      return
    }

    // 审批（E5）：列表是"持久视图"（控制帧易失，页面刷新后要靠它拿回待回答项）
    if (segments[0] === 'api' && segments[1] === 'approvals') {
      const approval = options.approval
      if (approval === undefined) {
        throw new HttpError(409, 'this workbench runs a static approval policy; no interactive approvals are available')
      }
      if (segments.length === 2 && method === 'GET') {
        sendJson(res, 200, approval.list())
        return
      }
      const approvalId = segments[2]
      if (segments.length === 3 && approvalId !== undefined && method === 'POST') {
        const body = await readJsonBody(req)
        const decision = body['decision']
        if (decision !== 'allow' && decision !== 'deny') {
          throw new HttpError(400, 'POST /api/approvals/:id requires {"decision":"allow"|"deny"}')
        }
        const reason = body['reason']
        if (reason !== undefined && typeof reason !== 'string') {
          throw new HttpError(400, '"reason" must be a string when provided')
        }
        const resolved = approval.resolve(approvalId, decision, reason)
        sendJson(res, 200, resolved)
        return
      }
      throw new HttpError(404, 'no such endpoint: ' + method + ' ' + url.pathname)
    }

    if (segments[0] === 'api' && segments[1] === 'sessions' && segments.length === 2) {
      if (method === 'GET') {
        sendJson(res, 200, { sessions: await listSessions(sessionsDir) })
        return
      }
      if (method === 'POST') {
        const session = await runtime.create()
        sendJson(res, 201, { session })
        return
      }
      throw new HttpError(405, 'method not allowed: ' + method)
    }

    const sessionId = segments[2]
    if (segments[0] === 'api' && segments[1] === 'sessions' && sessionId !== undefined) {
      const directory = join(sessionsDir, sessionId)

      if (segments.length === 3 && method === 'GET') {
        const summary = await readSessionSummary(directory)
        const open = summary.problems.length === 0
        sendJson(res, 200, {
          summary,
          ...(open ? { snapshot: await runtime.mountSnapshot(sessionId) } : {}),
          ...(open ? { budget: runtime.budgetState(sessionId) } : {}),
          run: runs.get(sessionId) ?? null,
        })
        return
      }

      if (segments.length === 4 && segments[3] === 'run' && method === 'POST') {
        const body = await readJsonBody(req)
        const task = body['task']
        if (typeof task !== 'string' || task.trim() === '') {
          throw new HttpError(400, 'run requires a non-empty "task" string')
        }
        if (runs.get(sessionId)?.finishedAt === undefined && runs.has(sessionId)) {
          throw new HttpError(409, 'a run is already in flight for this session')
        }
        if (!summaryExists(await listSessions(sessionsDir), sessionId)) {
          throw new HttpError(404, 'session not found: ' + sessionId)
        }
        void startRun(sessionId, task)
        sendJson(res, 202, { started: true, sessionId })
        return
      }

      if (segments.length === 4 && segments[3] === 'events' && method === 'GET') {
        await streamEvents(req, res, sessionId)
        return
      }

      if (segments.length === 4 && segments[3] === 'changes' && method === 'GET') {
        if (git === undefined || options.workspaceDir === undefined) {
          throw new HttpError(409, 'this workbench was started without a workspace, so no change report is available')
        }
        const state = runs.get(sessionId)
        if (state?.baseline === undefined) {
          throw new HttpError(409, 'no run has been recorded for this session yet, so there is no baseline to compare against')
        }
        // 报告按需计算（不缓存）：请求时的工作区状态 - 运行前基线
        sendJson(res, 200, { changes: await git.report(options.workspaceDir, state.baseline) })
        return
      }

      if (segments.length === 4 && segments[3] === 'resume' && method === 'POST') {
        const resumed = await runtime.resume({ directory, id: sessionId })
        publish(sessionId, {
          event: 'session-resumed',
          data: {
            sessionId,
            formatVersion: resumed.formatVersion,
            settled: resumed.settled,
            settlementEvents: resumed.settlementEvents,
          },
        })
        sendJson(res, 200, resumed)
        return
      }

      throw new HttpError(404, 'no such endpoint: ' + method + ' ' + url.pathname)
    }

    throw new HttpError(404, 'no such endpoint: ' + method + ' ' + url.pathname)
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) {
        res.end()
        return
      }
      sendJson(res, statusFor(error), { error: messageOf(error) })
    })
  })

  const host = listen.host ?? '127.0.0.1'
  const port = listen.port ?? 0
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address !== null ? address.port : port

  return {
    url: 'http://' + host + ':' + String(boundPort),
    port: boundPort,
    host,
    close: async () => {
      unsubscribeApproval?.()
      for (const set of listeners.values()) set.clear()
      listeners.clear()
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error === undefined || error === null ? resolve() : reject(error)))
      })
    },
  }
}

function summaryExists(summaries: readonly { id: string }[], sessionId: string): boolean {
  return summaries.some(summary => summary.id === sessionId)
}
