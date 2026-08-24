import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { agentLoopPlugin } from '@cubus/agent-loop'
import type { Tool } from '@cubus/agent-loop'
import { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import type { SessionEvent } from '@cubus/session'
import { RpcInvalidParamsError } from './server.ts'
import type { RpcMethod } from './server.ts'

export interface SessionInfo {
  id: string
  logPath: string
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
}

export interface SessionRuntimeOptions {
  /** 会话目录根：每个会话一个子目录 + session.jsonl。 */
  rootDir: string
  /** 适配器工厂：每个会话创建独立实例（会话间不共享模型状态）。 */
  adapterFactory: () => LlmAdapter
  /** 系统提示：传给循环插件。 */
  systemPrompt?: string
  /** 工具集：传给循环插件（默认 echo）。 */
  tools?: Tool[]
  /** 会话 ID 生成器（测试注入计数器实现确定性）。 */
  generateId?: () => string
}

/**
 * 会话运行时：协议背后的产品门面。
 * 每个会话 = 一棵独立的 cordis 树（provider 插件 + 循环插件 + 自己的日志文件），
 * 会话之间零共享、零干扰。
 */
export class SessionRuntime {
  private readonly sessions = new Map<string, SessionEntry>()
  private readonly opts: SessionRuntimeOptions
  private readonly generateId: () => string

  constructor(opts: SessionRuntimeOptions) {
    this.opts = opts
    this.generateId = opts.generateId ?? randomUUID
  }

  async create(): Promise<SessionInfo> {
    const id = this.generateId()
    const dir = join(this.opts.rootDir, id)
    await mkdir(dir, { recursive: true })
    const adapter = this.opts.adapterFactory()

    const ctx = new Context()
    await ctx.plugin({
      name: 'llm-provider',
      apply(c: Context) {
        c.provide('llm', adapter)
      },
    })
    await ctx.plugin(agentLoopPlugin, {
      logPath: join(dir, 'session.jsonl'),
      ...(this.opts.systemPrompt === undefined ? {} : { systemPrompt: this.opts.systemPrompt }),
      ...(this.opts.tools === undefined ? {} : { tools: this.opts.tools }),
    })

    const logPath = join(dir, 'session.jsonl')
    this.sessions.set(id, { id, logPath, ctx })
    return { id, logPath }
  }

  async run(sessionId: string, text: string): Promise<RunResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`session not found: ${sessionId}`)

    const log = session.ctx.get('sessionLog')
    const loop = session.ctx.get('loop')
    if (!log || !loop) throw new Error('session kernel not ready')

    const { events: before } = await log.read()
    await loop.submit([{ type: 'text', text }])
    const { events } = await log.read()

    const turnEvents = events.slice(before.length)
    const lastAssistant = [...turnEvents].reverse().find(e => e.type === 'assistant/message')
    const assistantText = lastAssistant?.content[0]?.text
    // exactOptionalPropertyTypes：可选字段不能携带显式 undefined，只能整体缺省
    return { ...(assistantText === undefined ? {} : { assistantText }), turnEvents }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map(s => ({ id: s.id, logPath: s.logPath }))
  }
}

/** 把运行时包装成 JSON-RPC 方法表（wire 边界上的参数校验发生在这里）。 */
export function createRunnerMethods(runtime: SessionRuntime): Record<string, RpcMethod> {
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
    'session.list': () => runtime.list(),
  }
}

