import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createAgentRuntimePlugin } from '@cubus/agent-recipe'
import type { AgentHost, AgentRecipe, AgentSessionDescriptor, CapabilityPins } from '@cubus/agent-recipe'
import { Context } from '@cubus/cordis'
import type { BudgetState } from '@cubus/budget'
import {
  parseSessionMeta,
  planSettlement,
  renderSessionMeta,
  settlementEvents,
  SESSION_FORMAT_VERSION,
} from '@cubus/session'
import type { BudgetLimits, MountSnapshot, SessionEvent } from '@cubus/session'
import { ConcurrencyGate } from './concurrency.ts'
import type { ConcurrencySnapshot } from './concurrency.ts'
import { RpcInvalidParamsError } from './server.ts'
import type { RpcMethod } from './server.ts'

export interface SessionInfo {
  id: string
  logPath: string
}

export interface ResumeOptions {
  /** 已存在的会话目录（里面应有 session.jsonl 与 session.meta.json）。 */
  directory: string
  /** 会话 id；缺省取目录名。 */
  id?: string
}

export interface ResumeResult {
  session: SessionInfo
  /** 这份日志的格式版本（缺失 sidecar 记为 1）。 */
  formatVersion: number
  /** 是否补写了结算事件（崩溃留下的未闭合区间）。 */
  settled: boolean
  settlementEvents: readonly SessionEvent[]
}

/** 一次会话运行的回合结果（协议返回值）。 */
export interface RunResult {
  /** 本回合最后一条完整模型回复的文本；无回复时为 undefined。 */
  assistantText?: string
  /** 本回合产生的全部日志事件（turn/start 到 turn/end）。 */
  turnEvents: SessionEvent[]
}

interface SessionEntry {
  id: string
  logPath: string
  ctx: Context
  /** Serializes runs for this session so each caller owns one complete turn interval. */
  runTail: Promise<void>
}

export interface SessionRuntimeOptions<RecipeOptions = void> {
  /** 会话目录根：每个会话一个子目录 + session.jsonl。 */
  rootDir: string
  /** 环境供应方：模型、会话存储和其他部署资源。 */
  host: AgentHost
  /** 产品配方：提示词、工具与领域行为。 */
  recipe: AgentRecipe<RecipeOptions>
  /** 绑定到所有新会话的 typed Recipe 配置。 */
  recipeOptions: RecipeOptions
  /** app 级 pin：声明式装配下同一能力有多种候选时消解歧义。 */
  capabilityPins?: CapabilityPins
  /** app 级审批档覆盖；优先级高于 manifest.permission.profile。 */
  permissionProfile?: string
  /** 生效预算上限（app 覆盖 > manifest.budget）；设置时装配预算策略插件。 */
  budget?: BudgetLimits
  /** 跨会话并发运行上限（C6）；默认 4。会话内串行不受影响。 */
  maxConcurrentRuns?: number
  /** 排队等待上限（毫秒）；0 = 不排队，没名额直接失败。默认 120000。 */
  queueWaitMs?: number
  /** 会话 ID 生成器（测试注入计数器实现确定性）。 */
  generateId?: () => string
}

/**
 * 会话运行时：协议背后的产品门面。
 * 每个会话 = 一棵独立的 cordis 树（provider 插件 + 循环插件 + 自己的日志文件），
 * 会话之间零共享、零干扰。
 */
export class SessionRuntime<RecipeOptions = void> {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly opts: SessionRuntimeOptions<RecipeOptions>
  private readonly generateId: () => string
  private readonly gate: ConcurrencyGate

  constructor(opts: SessionRuntimeOptions<RecipeOptions>) {
    this.opts = opts
    this.generateId = opts.generateId ?? randomUUID
    this.gate = new ConcurrencyGate({
      limit: opts.maxConcurrentRuns ?? 4,
      waitMs: opts.queueWaitMs ?? 120_000,
    })
  }

  /** 并发与排队状态（C6）：给 app / 工作台看的名额占用与排队位置。 */
  concurrency(): ConcurrencySnapshot {
    return this.gate.snapshot()
  }

  /** 装配一个会话（create 与 resume 共用；resume 时插件会校验装配身份且不写第二条快照）。 */
  private async mount(
    descriptor: AgentSessionDescriptor,
    extras: { resume?: true } = {},
  ): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(createAgentRuntimePlugin({
      host: this.opts.host,
      recipe: this.opts.recipe,
      recipeOptions: this.opts.recipeOptions,
      session: descriptor,
      ...(this.opts.capabilityPins === undefined ? {} : { capabilityPins: this.opts.capabilityPins }),
      ...(this.opts.permissionProfile === undefined ? {} : { permissionProfile: this.opts.permissionProfile }),
      ...(this.opts.budget === undefined ? {} : { budget: this.opts.budget }),
      ...(extras.resume === true ? { resume: true as const } : {}),
    }))
    return ctx
  }

  async create(): Promise<SessionInfo> {
    const id = this.generateId()
    const dir = join(this.opts.rootDir, id)
    await mkdir(dir, { recursive: true })
    const logPath = join(dir, 'session.jsonl')
    const descriptor: AgentSessionDescriptor = Object.freeze({ id, directory: dir, logPath })

    // 格式版本 sidecar（D3）：装配前写好，读取方据此判断能不能读这份日志。
    await writeFile(join(dir, 'session.meta.json'), renderSessionMeta({
      formatVersion: SESSION_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      sessionId: id,
      recipe: { id: this.opts.recipe.manifest.id, version: this.opts.recipe.manifest.version },
    }), 'utf8')

    const ctx = await this.mount(descriptor)
    this.sessions.set(id, { id, logPath, ctx, runTail: Promise.resolve() })
    return { id, logPath }
  }

  /**
   * 恢复一个已存在的会话（D3）：校验格式版本 → 重新装配（装配身份必须一致）→ 结算未闭合区间。
   *
   * 不做的事：不重放任何已记录的副作用、不重放孤儿工具调用（不知道它是否已经产生副作用）、
   * 不回滚崩溃前的半成品改动。恢复是"继续"，不是"重来"。
   */
  async resume(options: ResumeOptions): Promise<ResumeResult> {
    const directory = options.directory
    const id = options.id ?? basename(directory)
    const logPath = join(directory, 'session.jsonl')
    if (this.sessions.has(id)) throw new Error('session already open: ' + id)

    // 格式版本：文件缺失按 v1；更高版本直接拒绝（不静默降级）。
    let rawMeta: string | undefined
    try {
      rawMeta = await readFile(join(directory, 'session.meta.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const meta = parseSessionMeta(rawMeta)

    const ctx = await this.mount(Object.freeze({ id, directory, logPath }), { resume: true })

    const log = ctx.get('sessionLog')
    if (log === undefined) throw new Error('session kernel not ready')
    const { events } = await log.read()
    const settledEvents = settlementEvents(planSettlement(events))
    for (const event of settledEvents) await log.append(event)

    this.sessions.set(id, { id, logPath, ctx, runTail: Promise.resolve() })
    return {
      session: { id, logPath },
      formatVersion: meta.formatVersion,
      settled: settledEvents.length > 0,
      settlementEvents: settledEvents,
    }
  }

  async run(sessionId: string, text: string): Promise<RunResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`session not found: ${sessionId}`)

    const operation = session.runTail.then(async () => {
      const log = session.ctx.get('sessionLog')
      const loop = session.ctx.get('loop')
      if (!log || !loop) throw new Error('session kernel not ready')

      // 跨会话并发上限（C6）：拿到名额才真正开始这一轮；
      // 会话内串行由 runTail 保证，因此排队发生在"轮到本会话"之后。
      const release = await this.gate.acquire(sessionId)
      try {
        const { events: before } = await log.read()
        await loop.submit([{ type: 'text', text }])
        const { events } = await log.read()

        const turnEvents = events.slice(before.length)
        const lastAssistant = [...turnEvents].reverse().find(e => e.type === 'assistant/message')
        const assistantText = lastAssistant?.content[0]?.text
        // exactOptionalPropertyTypes：可选字段不能携带显式 undefined，只能整体缺省
        return { ...(assistantText === undefined ? {} : { assistantText }), turnEvents }
      } finally {
        release()
      }
    })
    // A failed run rejects only its caller; later queued runs still get their turn.
    session.runTail = operation.then(() => undefined, () => undefined)
    return operation
  }

  /**
   * 读取该会话的装配快照（日志第一条 `session/mount`）。
   *
   * 供 app 侧如实告知"这次运行有没有隔离"；日志里没有快照（异常或旧日志）时返回 undefined。
   */
  async mountSnapshot(sessionId: string): Promise<MountSnapshot | undefined> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('session not found: ' + sessionId)
    const log = session.ctx.get('sessionLog')
    if (log === undefined) return undefined
    const { events } = await log.read()
    const mount = events.find(event => event.type === 'session/mount')
    return mount?.type === 'session/mount' ? mount.mount : undefined
  }

  /**
   * 读取该会话的预算状态（步数 / 工具调用数 / 耗时 / 是否超限）。
   * 未配置预算时返回 undefined。
   */
  budgetState(sessionId: string): BudgetState | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('session not found: ' + sessionId)
    return session.ctx.get('budget')?.state()
  }

  /**
   * 订阅该会话后续落盘的事件（实时视图，顺序与日志一致，落盘后才回调）。
   * 返回取消订阅函数；provider 不支持实时流时返回 no-op。
   */
  subscribe(sessionId: string, listener: (event: SessionEvent) => void): () => void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('session not found: ' + sessionId)
    const log = session.ctx.get('sessionLog')
    if (log?.subscribe === undefined) return () => {}
    return log.subscribe(listener)
  }

  /** Cancel only the currently running turn; queued or future runs remain available. */
  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`session not found: ${sessionId}`)
    const loop = session.ctx.get('loop')
    if (!loop) throw new Error('session kernel not ready')
    loop.cancel()
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(s => ({ id: s.id, logPath: s.logPath }))
  }
}

/** 把运行时包装成 JSON-RPC 方法表（wire 边界上的参数校验发生在这里）。 */
export function createRunnerMethods<RecipeOptions>(runtime: SessionRuntime<RecipeOptions>): Record<string, RpcMethod> {
  return {
    'session.create': () => runtime.create(),
    'session.run': params => {
      const sessionId = params['sessionId']
      const text = params['text']
      if (typeof sessionId !== 'string' || typeof text !== 'string') {
        throw new RpcInvalidParamsError('session.run requires sessionId and text strings')
      }
      return runtime.run(sessionId, text)
    },
    'session.cancel': params => {
      const sessionId = params['sessionId']
      if (typeof sessionId !== 'string') {
        throw new RpcInvalidParamsError('session.cancel requires a sessionId string')
      }
      runtime.cancel(sessionId)
      return { sessionId }
    },
    'session.list': () => runtime.list(),
  }
}
