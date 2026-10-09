/**
 * 有界并发闸门（C6；设计见 docs/design/sandbox-seam.md §7）。
 *
 * 作用域：**跨会话**的并发运行上限。会话内串行早就有（S2.3a 的 runTail），
 * 这里解决的是"一次来太多会话"——模型配额、容器数量、CPU 都是全局稀缺资源。
 *
 * 语义：
 * - 名额有空 -> 立即获得；
 * - 没空 -> 按 FIFO 排队，等待上限 queueWaitMs（0 = 不排队，没名额直接失败）；
 * - 等待期间被 abort -> 立刻出队并以 abort 原因 reject（不留残留）；
 * - 超时 -> 出队并抛 QueueTimeoutError；
 * - 释放名额直接交给队首（交接，不经过"空闲"窗口），因此上限不会被突破。
 */
export class QueueTimeoutError extends Error {
  readonly limit: number
  readonly queued: number
  readonly waitedMs: number

  constructor(details: { limit: number; queued: number; waitedMs: number }) {
    super(
      'timed out waiting for a concurrency slot after ' + String(details.waitedMs) +
      'ms (limit ' + String(details.limit) + ', still queued ' + String(details.queued) + ')',
    )
    this.name = 'QueueTimeoutError'
    this.limit = details.limit
    this.queued = details.queued
    this.waitedMs = details.waitedMs
  }
}

export interface ConcurrencySnapshot {
  readonly limit: number
  readonly active: number
  readonly queued: number
  /** 排队者（FIFO 顺序，position 从 1 开始）。 */
  readonly waiters: readonly { sessionId: string; position: number; waitedMs: number }[]
}

interface Waiter {
  readonly sessionId: string
  readonly enqueuedAt: number
  readonly grant: () => void
  readonly fail: (error: unknown) => void
  timer: ReturnType<typeof setTimeout> | undefined
  detachAbort: (() => void) | undefined
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error('aborted while waiting for a concurrency slot')
}

export class ConcurrencyGate {
  readonly limit: number
  readonly waitMs: number
  private readonly now: () => number
  private active = 0
  private readonly waiters: Waiter[] = []

  constructor(options: { limit: number; waitMs: number; now?: () => number }) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new TypeError('maxConcurrentRuns must be a positive integer, got ' + String(options.limit))
    }
    if (!Number.isInteger(options.waitMs) || options.waitMs < 0) {
      throw new TypeError('queueWaitMs must be a non-negative integer, got ' + String(options.waitMs))
    }
    this.limit = options.limit
    this.waitMs = options.waitMs
    this.now = options.now ?? Date.now
  }

  /** 申请一个运行名额；返回幂等的释放函数。 */
  async acquire(sessionId: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw abortReason(signal)
    if (this.active < this.limit) {
      this.active += 1
      return this.releaseOnce()
    }

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        sessionId,
        enqueuedAt: this.now(),
        grant: () => resolve(),
        fail: error => reject(error),
        timer: undefined,
        detachAbort: undefined,
      }
      waiter.timer = setTimeout(() => {
        this.drop(waiter)
        reject(new QueueTimeoutError({ limit: this.limit, queued: this.waiters.length, waitedMs: this.waitMs }))
      }, this.waitMs)
      waiter.timer.unref?.()
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.drop(waiter)
          reject(abortReason(signal))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiter.detachAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.waiters.push(waiter)
    })

    // 名额由释放方在不减少 active 的情况下直接交接，因此这里不再自增。
    return this.releaseOnce()
  }

  snapshot(): ConcurrencySnapshot {
    const now = this.now()
    return {
      limit: this.limit,
      active: this.active,
      queued: this.waiters.length,
      waiters: this.waiters.map((waiter, index) => ({
        sessionId: waiter.sessionId,
        position: index + 1,
        waitedMs: Math.max(0, now - waiter.enqueuedAt),
      })),
    }
  }

  private releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
      this.grantNext()
    }
  }

  private grantNext(): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) return
    this.settle(waiter)
    // 交接：名额直接转给队首，中途不发布空闲状态。
    this.active += 1
    waiter.grant()
  }

  /** 出队（超时/取消）：清掉计时器与 abort 监听。 */
  private drop(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
    this.settle(waiter)
  }

  private settle(waiter: Waiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    waiter.timer = undefined
    waiter.detachAbort?.()
    waiter.detachAbort = undefined
  }
}
