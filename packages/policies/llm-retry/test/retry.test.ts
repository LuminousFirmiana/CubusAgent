import { expect, test } from 'vitest'
import { LlmError } from '@cubus/llm'
import type { LlmAdapter, LlmChunk } from '@cubus/llm'
import { withLlmRetry } from '../src/index.ts'

const request = {
  provider: 'retry-test',
  model: 'model',
  messages: [],
}

async function collect(adapter: LlmAdapter, signal = new AbortController().signal): Promise<LlmChunk[]> {
  const chunks: LlmChunk[] = []
  for await (const chunk of adapter.stream(request, signal)) chunks.push(chunk)
  return chunks
}

async function* failBeforeChunk(error: unknown): AsyncGenerator<LlmChunk, void, void> {
  yield await Promise.reject(error)
}

test('retries typed transient failures with bounded exponential delays', async () => {
  let attempts = 0
  const delays: number[] = []
  const adapter: LlmAdapter = {
    provider: 'test',
    model: 'model',
    async *stream() {
      attempts += 1
      if (attempts < 3) {
        throw new LlmError('temporary', { kind: 'server', retryable: true })
      }
      yield { delta: 'done' }
    },
  }
  const retried = withLlmRetry(adapter, {
    maxAttempts: 3,
    initialDelayMs: 10,
    maxDelayMs: 100,
    async sleep(delayMs) { delays.push(delayMs) },
  })

  await expect(collect(retried)).resolves.toEqual([{ delta: 'done' }])
  expect(attempts).toBe(3)
  expect(delays).toEqual([10, 20])
})

test('does not retry permanent, unknown, exhausted, or partially emitted failures', async () => {
  const cases: { error: unknown }[] = [
    { error: new LlmError('bad key', { kind: 'authentication', retryable: false }) },
    { error: new Error('unknown') },
  ]
  for (const item of cases) {
    let attempts = 0
    const adapter: LlmAdapter = {
      provider: 'test',
      model: 'model',
      async *stream() {
        attempts += 1
        yield* failBeforeChunk(item.error)
      },
    }
    await expect(collect(withLlmRetry(adapter, { maxAttempts: 3, initialDelayMs: 0 }))).rejects.toBe(item.error)
    expect(attempts).toBe(1)
  }

  let attempts = 0
  const partial: LlmAdapter = {
    provider: 'test',
    model: 'model',
    async *stream() {
      attempts += 1
      yield { delta: 'visible' }
      throw new LlmError('stream broke', { kind: 'network', retryable: true })
    },
  }
  await expect(collect(withLlmRetry(partial, { maxAttempts: 3, initialDelayMs: 0 }))).rejects.toThrow('stream broke')
  expect(attempts).toBe(1)

  let exhaustedAttempts = 0
  const exhausted: LlmAdapter = {
    provider: 'test',
    model: 'model',
    async *stream() {
      exhaustedAttempts += 1
      yield* failBeforeChunk(new LlmError('still down', { kind: 'server', retryable: true }))
    },
  }
  await expect(collect(withLlmRetry(exhausted, { maxAttempts: 2, initialDelayMs: 0 }))).rejects.toThrow('still down')
  expect(exhaustedAttempts).toBe(2)
})

test('abort interrupts retry backoff immediately', async () => {
  const controller = new AbortController()
  let sleeping = false
  const adapter: LlmAdapter = {
    provider: 'test',
    model: 'model',
    async *stream() {
      yield* failBeforeChunk(new LlmError('temporary', { kind: 'network', retryable: true }))
    },
  }
  const retried = withLlmRetry(adapter, {
    maxAttempts: 3,
    initialDelayMs: 1,
    sleep: async (_delay, signal) => {
      sleeping = true
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  })
  const operation = collect(retried, controller.signal)
  while (!sleeping) await Promise.resolve()
  controller.abort(new Error('cancel retry'))

  await expect(operation).rejects.toThrow('cancel retry')
})

test('rejects invalid retry bounds at construction time', () => {
  const adapter: LlmAdapter = { provider: 'test', model: 'model', async *stream() {} }
  expect(() => withLlmRetry(adapter, { maxAttempts: 0 })).toThrow('maxAttempts must be a positive integer')
  expect(() => withLlmRetry(adapter, { initialDelayMs: 10, maxDelayMs: 5 })).toThrow(
    'maxDelayMs must be at least initialDelayMs',
  )
})
