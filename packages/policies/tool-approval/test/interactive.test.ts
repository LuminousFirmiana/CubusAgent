import { expect, test } from 'vitest'
import { createInteractiveToolApproval } from '../src/interactive.ts'
import type { ApprovalEvent } from '../src/interactive.ts'

const request = { toolName: 'bash', args: { command: 'ls' } }

test('allow and deny profiles answer immediately, like the static policy', async () => {
  const allow = createInteractiveToolApproval({ profile: 'allow' })
  const deny = createInteractiveToolApproval({ profile: 'deny' })

  expect(await allow.decide(request, { signal: new AbortController().signal })).toEqual({
    outcome: 'allow',
    reason: 'workbench --approval allow',
  })
  expect(await deny.decide(request, { signal: new AbortController().signal })).toEqual({
    outcome: 'deny',
    reason: 'workbench --approval deny',
  })
  // 静态档不产生待回答项
  expect(allow.list()).toEqual({ pending: [], queued: 0 })
})

test('ask waits for a user decision and reports it as an event', async () => {
  const approval = createInteractiveToolApproval({ profile: 'ask', generateId: () => 'a1' })
  const events: ApprovalEvent[] = []
  approval.onEvent(event => events.push(event))

  const deciding = approval.decide(request, { signal: new AbortController().signal })
  expect(approval.list().pending).toEqual([
    { id: 'a1', toolName: 'bash', args: { command: 'ls' }, requestedAt: expect.any(String), expiresAt: expect.any(String), queuePosition: 0 },
  ])

  const resolved = approval.resolve('a1', 'deny')
  expect(resolved.outcome).toBe('deny')
  expect(await deciding).toEqual({ outcome: 'deny', reason: 'the user rejected this tool call' })
  expect(approval.list()).toEqual({ pending: [], queued: 0 })

  expect(events.map(event => event.type)).toEqual(['requested', 'resolved'])
  expect(events[1]).toMatchObject({ type: 'resolved', outcome: 'deny', by: 'user' })
})

test('a tool call nobody answers is denied by default when the timeout fires', async () => {
  const approval = createInteractiveToolApproval({ profile: 'ask', timeoutMs: 20, generateId: () => 'a1' })
  const decision = await approval.decide(request, { signal: new AbortController().signal })

  expect(decision.outcome).toBe('deny')
  expect(decision.reason).toContain('timeout: no answer within 20ms')
  expect(decision.reason).toContain('denied by default')
  expect(approval.list()).toEqual({ pending: [], queued: 0 })

  // 超时后再回答 -> 未知（已结算），调用方据此回 404/409
  expect(() => approval.resolve('a1', 'allow')).toThrow('unknown or already answered approval: a1')
})

test('beyond maxPending the requests queue, and resolving one promotes the next', async () => {
  let counter = 0
  const approval = createInteractiveToolApproval({
    profile: 'ask',
    maxPending: 1,
    generateId: () => 'a' + String(++counter),
  })
  const events: ApprovalEvent[] = []
  approval.onEvent(event => events.push(event))

  const first = approval.decide({ toolName: 'bash', args: {} }, { signal: new AbortController().signal })
  const second = approval.decide({ toolName: 'read_file', args: {} }, { signal: new AbortController().signal })

  // 只有一个在等回答，另一个排队（requested 事件也只发一次）
  expect(approval.list().pending.map(item => item.id + ':' + String(item.queuePosition))).toEqual(['a1:0', 'a2:1'])
  expect(approval.list().queued).toBe(1)
  expect(events.filter(event => event.type === 'requested')).toHaveLength(1)

  approval.resolve('a1', 'allow')
  expect((await first).outcome).toBe('allow')
  // 队首被提升为等待中
  expect(approval.list().pending.map(item => item.id + ':' + String(item.queuePosition))).toEqual(['a2:0'])
  expect(events.filter(event => event.type === 'requested')).toHaveLength(2)

  approval.resolve('a2', 'deny', '太危险了')
  expect(await second).toEqual({ outcome: 'deny', reason: '太危险了' })
  expect(approval.list()).toEqual({ pending: [], queued: 0 })
})

test('resolving an unknown approval is an error, and listeners can unsubscribe', async () => {
  const approval = createInteractiveToolApproval({ profile: 'ask', generateId: () => 'a1' })
  expect(() => approval.resolve('nope', 'allow')).toThrow('unknown or already answered approval: nope')

  const seen: ApprovalEvent[] = []
  const unsubscribe = approval.onEvent(event => seen.push(event))
  const deciding = approval.decide(request, { signal: new AbortController().signal })
  unsubscribe()
  approval.resolve('a1', 'allow')
  await deciding
  // 退订前收到的 requested 保留；退订后的 resolved 不再送达
  expect(seen.map(event => event.type)).toEqual(['requested'])

  expect(() => createInteractiveToolApproval({ profile: 'ask', timeoutMs: 0 }))
    .toThrow('approval timeoutMs must be a positive integer')
  expect(() => createInteractiveToolApproval({ profile: 'ask', maxPending: 0 }))
    .toThrow('approval maxPending must be a positive integer')
})
