import { LlmError } from '@cubus/llm'

/**
 * 循环级重试（F4b）：与 @cubus/policies/llm-retry 同一套语义，区别是**在循环里**做，
 * 因此重试作为请求事实写进会话日志（request/retry），指标与审计都看得到。
 *
 * 只有"还没吐出任何 chunk 的瞬时失败"才重试（流到一半失败无法重放，重试会重复输出）。
 */

export type RetrySleep = (delayMs: number, signal: AbortSignal) => Promise<void>

export interface LoopRetryOptions {
  /** 总尝试次数（含首次）。默认 1（不重试）。 */
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
  /** 等待实现（测试注入以免真的等）。 */
  sleep?: RetrySleep
}

export interface ResolvedRetryOptions {
  readonly maxAttempts: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly backoffMultiplier: number
  readonly sleep: RetrySleep
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('aborted', 'AbortError')
}

export function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    function onAbort(): void {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function resolveRetryOptions(options: LoopRetryOptions | undefined): ResolvedRetryOptions {
  const maxAttempts = options?.maxAttempts ?? 1
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('retry.maxAttempts must be a positive integer')
  }
  return {
    maxAttempts,
    initialDelayMs: options?.initialDelayMs ?? 500,
    maxDelayMs: options?.maxDelayMs ?? 5_000,
    backoffMultiplier: options?.backoffMultiplier ?? 2,
    sleep: options?.sleep ?? abortableSleep,
  }
}

/** 值不值得重试：瞬时失败（LlmError.retryable）且还没有吐出任何 chunk。 */
export function isRetryable(error: unknown, emitted: boolean, attempt: number, retry: ResolvedRetryOptions): boolean {
  return !emitted
    && error instanceof LlmError
    && error.retryable === true
    && attempt < retry.maxAttempts
}

export function describeRetryFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
