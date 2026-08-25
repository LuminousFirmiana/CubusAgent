import { LlmError } from '@cubus/llm'
import type { LlmAdapter } from '@cubus/llm'

export type RetrySleep = (delayMs: number, signal: AbortSignal) => Promise<void>

export interface LlmRetryOptions {
  /** Total attempts including the first request. */
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffMultiplier?: number
  sleep?: RetrySleep
}

interface ResolvedRetryOptions {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
  sleep: RetrySleep
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
    function onAbort() {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  return value
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a non-negative finite number`)
  return value
}

function resolveOptions(options: LlmRetryOptions): ResolvedRetryOptions {
  const maxAttempts = positiveInteger(options.maxAttempts ?? 3, 'maxAttempts')
  const initialDelayMs = nonNegativeFinite(options.initialDelayMs ?? 500, 'initialDelayMs')
  const maxDelayMs = nonNegativeFinite(options.maxDelayMs ?? 5_000, 'maxDelayMs')
  const backoffMultiplier = nonNegativeFinite(options.backoffMultiplier ?? 2, 'backoffMultiplier')
  if (backoffMultiplier < 1) throw new TypeError('backoffMultiplier must be at least 1')
  if (maxDelayMs < initialDelayMs) throw new TypeError('maxDelayMs must be at least initialDelayMs')
  return {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier,
    sleep: options.sleep ?? abortableSleep,
  }
}

/** Retry only typed transient failures that happen before the first emitted model chunk. */
export function withLlmRetry(adapter: LlmAdapter, options: LlmRetryOptions = {}): LlmAdapter {
  const retry = resolveOptions(options)
  return {
    provider: adapter.provider,
    model: adapter.model,
    async *stream(request, signal) {
      let delayMs = retry.initialDelayMs
      for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
        let emitted = false
        try {
          for await (const chunk of adapter.stream(request, signal)) {
            emitted = true
            yield chunk
          }
          return
        } catch (error) {
          if (signal.aborted) throw error
          const canRetry = !emitted
            && error instanceof LlmError
            && error.retryable
            && attempt < retry.maxAttempts
          if (!canRetry) throw error
          await retry.sleep(delayMs, signal)
          delayMs = Math.min(retry.maxDelayMs, delayMs * retry.backoffMultiplier)
        }
      }
    },
  }
}
