import { expect, test } from 'vitest'
import { ConcurrencyGate, QueueTimeoutError } from '../src/concurrency.ts'

const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

test('a gate without spare slots queues the next caller and hands the slot over on release', async () => {
  const gate = new ConcurrencyGate({ limit: 1, waitMs: 1_000 })
  const order: string[] = []

  const releaseA = await gate.acquire('a')
  expect(gate.snapshot()).toMatchObject({ limit: 1, active: 1, queued: 0 })

  const waitingB = gate.acquire('b').then(release => {
    order.push('b-started')
    return release
  })
  const waitingC = gate.acquire('c').then(release => {
    order.push('c-started')
    return release
  })
  await tick()
  // FIFO：b 在前，c 在后，且都还没拿到名额
  expect(gate.snapshot().waiters.map(waiter => waiter.sessionId)).toEqual(['b', 'c'])
  expect(gate.snapshot().waiters.map(waiter => waiter.position)).toEqual([1, 2])
  expect(order).toEqual([])

  releaseA()
  const releaseB = await waitingB
  expect(order).toEqual(['b-started'])
  // 交接：释放后名额直接给 b，active 仍为 1，没有被突破
  expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1 })

  releaseB()
  const releaseC = await waitingC
  expect(order).toEqual(['b-started', 'c-started'])
  releaseC()
  expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 })
})

test('waiting longer than queueWaitMs fails with a clear error and leaves no residue', async () => {
  const gate = new ConcurrencyGate({ limit: 1, waitMs: 20 })
  const releaseA = await gate.acquire('a')

  await expect(gate.acquire('b')).rejects.toThrow(QueueTimeoutError)
  await expect(gate.acquire('b')).rejects.toThrow('timed out waiting for a concurrency slot')
  expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0 })
  expect(gate.snapshot().waiters).toEqual([])

  releaseA()
  expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 })
})

test('queueWaitMs 0 means fail fast instead of queueing', async () => {
  const gate = new ConcurrencyGate({ limit: 1, waitMs: 0 })
  const release = await gate.acquire('a')
  await expect(gate.acquire('b')).rejects.toBeInstanceOf(QueueTimeoutError)
  release()
})

test('an aborted waiter leaves the queue immediately and reports the abort reason', async () => {
  const gate = new ConcurrencyGate({ limit: 1, waitMs: 5_000 })
  const release = await gate.acquire('a')
  const controller = new AbortController()

  const waiting = gate.acquire('b', controller.signal)
  await tick()
  expect(gate.snapshot().queued).toBe(1)

  controller.abort(new Error('caller gave up'))
  await expect(waiting).rejects.toThrow('caller gave up')
  expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0 })

  // 已经 abort 的调用者直接失败，不入队
  await expect(gate.acquire('c', controller.signal)).rejects.toThrow('caller gave up')
  release()
})

test('releasing twice does not inflate the limit, and invalid options are rejected', async () => {
  const gate = new ConcurrencyGate({ limit: 2, waitMs: 100 })
  const release = await gate.acquire('a')
  release()
  release()
  expect(gate.snapshot().active).toBe(0)

  expect(() => new ConcurrencyGate({ limit: 0, waitMs: 0 })).toThrow('maxConcurrentRuns must be a positive integer')
  expect(() => new ConcurrencyGate({ limit: 1, waitMs: -1 })).toThrow('queueWaitMs must be a non-negative integer')
})
