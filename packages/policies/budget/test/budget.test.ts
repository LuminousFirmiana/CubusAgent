import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import type { SessionEvent, SessionLog, SessionLogListener, SessionLogReadResult } from '@cubus/session'
import { BudgetPolicy } from '../src/service.ts'
import type { BudgetTripReason } from '../src/service.ts'
import { budgetPolicyPlugin } from '../src/plugin.ts'

function stepStart(): SessionEvent {
  return { type: 'step/start', stepId: 's1', turnId: 't1' }
}

function toolCallEvent(): SessionEvent {
  return { type: 'tool/call', id: 'c1', stepId: 's1', name: 'bash', args: {} }
}

test('counts steps and tool calls and trips only when a limit is exceeded', () => {
  const trips: BudgetTripReason[] = []
  const policy = new BudgetPolicy({
    limits: { maxSteps: 2, maxToolCalls: 3 },
    onTrip: reason => trips.push(reason),
    now: 0,
  })

  policy.observe(stepStart(), 10)
  policy.observe(stepStart(), 20)
  expect(policy.state(20)).toMatchObject({ steps: 2, toolCalls: 0 })
  expect(trips).toEqual([])

  // 超过上限才触发（等于上限仍然允许）
  policy.observe(stepStart(), 30)
  expect(trips).toEqual(['max-steps'])
  expect(policy.state(30).tripped).toBe('max-steps')

  // 触发一次之后不再重复触发
  policy.observe(stepStart(), 40)
  expect(trips).toEqual(['max-steps'])
})

test('tool-call and duration limits trip independently', () => {
  const toolTrips: BudgetTripReason[] = []
  const toolPolicy = new BudgetPolicy({
    limits: { maxToolCalls: 1 },
    onTrip: reason => toolTrips.push(reason),
    now: 0,
  })
  toolPolicy.observe(toolCallEvent(), 1)
  expect(toolTrips).toEqual([])
  toolPolicy.observe(toolCallEvent(), 2)
  expect(toolTrips).toEqual(['max-tool-calls'])

  const timeTrips: BudgetTripReason[] = []
  const timePolicy = new BudgetPolicy({
    limits: { maxDurationMs: 1_000 },
    onTrip: reason => timeTrips.push(reason),
    now: 0,
  })
  timePolicy.check(999)
  expect(timeTrips).toEqual([])
  // 模型调用期间没有事件：轮询 check 也要能发现超时
  timePolicy.check(1_001)
  expect(timeTrips).toEqual(['max-duration'])
  expect(timePolicy.state(1_001).elapsedMs).toBe(1_001)
})

test('token usage accumulates from assistant messages and trips the token limit', () => {
  const trips: BudgetTripReason[] = []
  const policy = new BudgetPolicy({ limits: { maxTokens: 100 }, onTrip: reason => trips.push(reason), now: 0 })

  policy.observe(
    { type: 'assistant/message', messageId: 'm1', stepId: 's1', content: [], usage: { promptTokens: 60, completionTokens: 10, totalTokens: 70 } },
    1,
  )
  expect(policy.state(1).tokens).toBe(70)
  expect(trips).toEqual([])

  policy.observe(
    { type: 'assistant/message', messageId: 'm2', stepId: 's1', content: [], usage: { promptTokens: 30, completionTokens: 5, totalTokens: 35 } },
    2,
  )
  expect(policy.state(2).tokens).toBe(105)
  expect(trips).toEqual(['max-tokens'])

  // provider 没给 usage（例如旧日志或本地假模型）时不增长，也不报错
  policy.observe({ type: 'assistant/message', messageId: 'm3', stepId: 's2', content: [] }, 3)
  expect(policy.state(3).tokens).toBe(105)
})

test('history seeding continues the count across a crash without tripping on its own', () => {
  const trips: BudgetTripReason[] = []
  const history: SessionEvent[] = [
    { type: 'turn/start', turnId: 't1' },
    { type: 'step/start', stepId: 's1', turnId: 't1' },
    { type: 'tool/call', id: 'c1', stepId: 's1', name: 'bash', args: {} },
    { type: 'step/start', stepId: 's2', turnId: 't1' },
  ]

  // 历史本身不触发：先只计数，等下一次 check/observe 再判断
  const policy = new BudgetPolicy({ limits: { maxSteps: 2 }, onTrip: reason => trips.push(reason), history, now: 0 })
  expect(policy.state(0)).toMatchObject({ steps: 2, toolCalls: 1 })
  expect(trips).toEqual([])

  // 历史已用满上限：恢复后的第一个新 step 让累计值超过上限 -> 立刻 trip
  policy.observe({ type: 'step/start', stepId: 's3', turnId: 't2' }, 1)
  expect(trips).toEqual(['max-steps'])
  expect(policy.state(1).steps).toBe(3)
})

test('a budget without limits, or with non-positive limits, is rejected', () => {
  expect(() => new BudgetPolicy({ limits: {}, onTrip: () => {} })).toThrow('at least one limit')
  expect(() => new BudgetPolicy({ limits: { maxSteps: 0 }, onTrip: () => {} })).toThrow('positive integer')
  expect(() => new BudgetPolicy({ limits: { maxSteps: 1.5 }, onTrip: () => {} })).toThrow('positive integer')
  expect(() => new BudgetPolicy({ limits: { maxDurationMs: -1 }, onTrip: () => {} })).toThrow('positive integer')
})

class FakeLog implements SessionLog {
  private listener: SessionLogListener | undefined
  async append(): Promise<void> {}
  async read(): Promise<SessionLogReadResult> {
    return { events: [], truncated: false }
  }
  subscribe(listener: SessionLogListener): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }
  push(event: SessionEvent): void {
    this.listener?.(event)
  }
}

test('the plugin subscribes to the log, cancels the loop once and cleans up on dispose', async () => {
  const log = new FakeLog()
  let cancels = 0
  const ctx = new Context()
  const fiber = ctx.plugin({
    name: 'budget-host',
    apply(host: Context) {
      host.provide('sessionLog', log)
      host.provide('loop', { cancel: () => { cancels += 1 } } as never)
    },
  })
  await fiber

  const plugin = ctx.plugin(budgetPolicyPlugin, { limits: { maxSteps: 1 }, checkIntervalMs: 10_000 })
  await plugin

  expect(ctx.budget).toBeInstanceOf(BudgetPolicy)
  log.push(stepStart())
  expect(cancels).toBe(0)
  log.push(stepStart())
  expect(cancels).toBe(1)
  expect(ctx.budget.state().tripped).toBe('max-steps')

  await plugin.dispose()
  expect(ctx.get('budget')).toBeUndefined()
  // 卸载后不再响应日志事件
  log.push(stepStart())
  expect(cancels).toBe(1)
})
