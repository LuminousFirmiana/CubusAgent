import type { ToolApprovalDecision, ToolApprovalRequest, ToolApprovalService } from './service.ts'

/**
 * 交互式审批（E5）：把 ask 档变成"页面上等人回答"，超时默认拒绝。
 *
 * 设计要点（三条已确认的决定）：
 * 1. **超时 = 拒绝**：等待上限从请求创建算起（含排队时间），默认 120s；
 * 2. **拒绝与失败可区分**：拒绝的原因文本会随 ToolApprovalDeniedError 落进日志，
 *    与"批准了但执行失败"（ApprovedToolExecutionError）在日志里一眼可分；
 * 3. **全局排队**：同时等待回答的审批有上限（默认 8），超出的按 FIFO 排队，
 *    队列长度可查 —— 与 C6 的有界并发同一个思路。
 *
 * 它只依赖 service 的接口，不认识 HTTP/SSE：工作台订阅事件、把决定送回来即可。
 */

export interface PendingApproval {
  readonly id: string
  /** 发起这次调用的会话（可能缺省：老上下文或直接调用 decide 的场景）。 */
  readonly sessionId?: string
  readonly toolName: string
  readonly args: unknown
  readonly requestedAt: string
  readonly expiresAt: string
  /** 0 = 正在等用户回答；>0 = 队列里的名次（1 起，全局 FIFO）。 */
  readonly queuePosition: number
}

export type ApprovalEvent =
  | { readonly type: 'requested'; readonly approval: PendingApproval }
  | {
      readonly type: 'resolved'
      readonly approval: PendingApproval
      readonly outcome: 'allow' | 'deny'
      readonly reason: string
      /** user = 用户回答；timeout = 超时未回答（等同拒绝）。 */
      readonly by: 'user' | 'timeout'
    }

export interface InteractiveApproval extends ToolApprovalService {
  /** 当前等待中的审批（按请求时间排序）与排队数量。 */
  list(): { readonly pending: readonly PendingApproval[]; readonly queued: number }
  /** 用户回答：allow/deny；未知 id 或已回答过 -> 抛错（调用方据此回 404/409）。 */
  resolve(id: string, outcome: 'allow' | 'deny', reason?: string): ApprovalEvent & { type: 'resolved' }
  onEvent(listener: (event: ApprovalEvent) => void): () => void
}

export interface InteractiveApprovalOptions {
  /** 默认档：只有 ask 会等待；allow/deny 与静态档同义。 */
  readonly profile: 'ask' | 'allow' | 'deny'
  /** 等待上限（毫秒）；超时按拒绝处理。默认 120000。 */
  readonly timeoutMs?: number
  /** 同时等待用户回答的上限，超出的排队。默认 8。 */
  readonly maxPending?: number
  readonly generateId?: () => string
  readonly now?: () => number
}

interface Waiter {
  readonly approval: PendingApproval
  readonly settle: (decision: ToolApprovalDecision) => void
  readonly fail: (error: unknown) => void
  timer: ReturnType<typeof setTimeout> | undefined
  active: boolean
}

export function createInteractiveToolApproval(options: InteractiveApprovalOptions): InteractiveApproval {
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxPending = options.maxPending ?? 8
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('approval timeoutMs must be a positive integer')
  }
  if (!Number.isInteger(maxPending) || maxPending < 1) {
    throw new TypeError('approval maxPending must be a positive integer')
  }

  const now = options.now ?? Date.now
  const generateId = options.generateId ?? (() => 'approval-' + Math.random().toString(36).slice(2, 10))
  const listeners = new Set<(event: ApprovalEvent) => void>()
  /** 正在等回答的（active）与排队的（queued），按到达顺序。 */
  const waiting: Waiter[] = []
  const resolving = new Map<string, Waiter>()

  function publish(event: ApprovalEvent): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener(event)
      } catch {
        // 单个订阅者出错不影响审批本身（订阅者只是 UI）
      }
    }
  }

  function describe(waiter: Waiter): PendingApproval {
    const position = waiting.indexOf(waiter)
    const activeCount = waiting.filter(candidate => candidate.active).length
    return {
      ...waiter.approval,
      // 0 = 正在等用户回答；>0 = 队列名次（1 起）。FIFO 提升保证 active 一定排在队首。
      queuePosition: waiter.active ? 0 : Math.max(1, position - activeCount + 1),
    }
  }

  function snapshot(): { pending: readonly PendingApproval[]; queued: number } {
    const pending = waiting.map(describe)
    return { pending, queued: pending.filter(item => item.queuePosition > 0).length }
  }

  /** 有空位就把队首激活（超时从请求创建时刻算起，排队时间也算）。 */
  function promote(): void {
    while (waiting.filter(candidate => candidate.active).length < maxPending) {
      const next = waiting.find(candidate => !candidate.active)
      if (next === undefined) return
      next.active = true
      publish({ type: 'requested', approval: describe(next) })
    }
  }

  function finish(waiter: Waiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    waiter.timer = undefined
    const index = waiting.indexOf(waiter)
    if (index >= 0) waiting.splice(index, 1)
    resolving.delete(waiter.approval.id)
    promote()
  }

  function settle(waiter: Waiter, decision: ToolApprovalDecision, by: 'user' | 'timeout'): void {
    const approval = describe(waiter)
    finish(waiter)
    publish({
      type: 'resolved',
      approval,
      outcome: decision.outcome,
      reason: decision.reason ?? '',
      by,
    })
    waiter.settle(decision)
  }

  return {
    decide(request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
      if (options.profile === 'allow') {
        return Promise.resolve({ outcome: 'allow', reason: 'workbench --approval allow' })
      }
      if (options.profile === 'deny') {
        return Promise.resolve({ outcome: 'deny', reason: 'workbench --approval deny' })
      }

      const startedAt = now()
      return new Promise<ToolApprovalDecision>((resolve, reject) => {
        const waiter: Waiter = {
          approval: {
            id: generateId(),
            ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
            toolName: request.toolName,
            args: request.args,
            requestedAt: new Date(startedAt).toISOString(),
            expiresAt: new Date(startedAt + timeoutMs).toISOString(),
            queuePosition: 0,
          },
          settle: resolve,
          fail: reject,
          timer: undefined,
          active: false,
        }
        waiter.timer = setTimeout(() => {
          settle(
            waiter,
            {
              outcome: 'deny',
              reason: 'timeout: no answer within ' + String(timeoutMs) + 'ms (denied by default)',
            },
            'timeout',
          )
        }, timeoutMs)
        waiting.push(waiter)
        resolving.set(waiter.approval.id, waiter)
        promote()
      })
    },

    list() {
      return snapshot()
    },

    resolve(id, outcome, reason) {
      const waiter = resolving.get(id)
      if (waiter === undefined) throw new Error('unknown or already answered approval: ' + id)
      const defaultReason = outcome === 'allow'
        ? 'the user allowed this tool call'
        : 'the user rejected this tool call'
      const decision: ToolApprovalDecision = { outcome, reason: reason ?? defaultReason }
      const approval = describe(waiter)
      settle(waiter, decision, 'user')
      return {
        type: 'resolved',
        approval,
        outcome,
        reason: decision.reason ?? defaultReason,
        by: 'user',
      }
    },

    onEvent(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
