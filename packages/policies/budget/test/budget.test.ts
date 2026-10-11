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
  // 时长窗口从回合开始算：回合开了才计。
  timePolicy.observe({ type: 'turn/start', turnId: 't1' }, 0)
  timePolicy.check(999)
  expect(timeTrips).toEqual([])
  // 模型调用期间没有事件：轮询 check 也要能发现超时
  timePolicy.check(1_001)
  expect(timeTrips).toEqual(['max-duration'])
  expect(timePolicy.state(1_001).elapsedMs).toBe(1_001)
})

test('idle time outside a turn is not budget: a long-lived console session can still run', () => {
  const trips: BudgetTripReason[] = []
  const policy = new BudgetPolicy({
    limits: { maxDurationMs: 600_000 },
    onTrip: reason => trips.push(reason),
    now: 0,
  })

  // 装配后空闲一小时：不该判超时（工作台里会话是长期开着的）。
  policy.check(3_600_000)
  expect(trips).toEqual([])
  expect(policy.state(3_600_000).elapsedMs).toBe(0)

  // 回合内超过上限才判超时。
  policy.observe({ type: 'turn/start', turnId: 't1' }, 3_600_000)
  policy.check(3_600_000 + 599_999)
  expect(trips).toEqual([])
  policy.check(3_600_000 + 600_001)
  expect(trips).toEqual(['max-duration'])
})

test('a closed turn freezes the window: no trip while idle, elapsed is this run', () => {
  const trips: BudgetTripReason[] = []
  const policy = new BudgetPolicy({ limits: { maxDurationMs: 1_000 }, onTrip: reason => trips.push(reason), now: 0 })

  policy.observe({ type: 'turn/start', turnId: 't1' }, 0)
  policy.observe(stepStart(), 100)
  policy.observe({ type: 'turn/end', turnId: 't1' }, 400)
  expect(policy.state(400).elapsedMs).toBe(400)

  // 回合结束后的空闲不再累计，也不会因为"停了很久"而超时。
  policy.check(10_000_000)
  expect(trips).toEqual([])
  expect(policy.state(10_000_000).elapsedMs).toBe(400)
})

test('a new turn opens a fresh duration window and clears the previous verdict', () => {
  const trips: BudgetTripReason[] = []
  const policy = new BudgetPolicy({ limits: { maxDurationMs: 1_000 }, onTrip: reason => trips.push(reason), now: 0 })

  // 第一次运行超时 → 取消一次。
  policy.observe({ type: 'turn/start', turnId: 't1' }, 0)
  policy.check(1_001)
  expect(trips).toEqual(['max-duration'])
  expect(policy.state(1_001).tripped).toBe('max-duration')

  // 上一次的结论不带到下一次运行：新回合重新计时。
  policy.observe({ type: 'turn/end', turnId: 't1' }, 1_002)
  policy.observe({ type: 'turn/start', turnId: 't2' }, 1_000_000)
  expect(policy.state(1_000_000).tripped).toBeUndefined()
  policy.check(1_000_500)
  expect(trips).toEqual(['max-duration'])
  policy.check(1_001_001)
  expect(trips).toEqual(['max-duration', 'max-duration'])
})

test('step counters keep accumulating across turns: an out-of-budget session trips at once', () => {
  const trips: BudgetTripReason[] = []
  const policy = new BudgetPolicy({ limits: { maxSteps: 2 }, onTrip: reason => trips.push(reason), now: 0 })

  policy.observe({ type: 'turn/start', turnId: 't1' }, 0)
  policy.observe(stepStart(), 1)
  policy.observe({ type: 'turn/end', turnId: 't1' }, 2)

  // 新回合不会把已用的步数清零：等于上限仍允许，超过才触发。
  policy.observe({ type: 'turn/start', turnId: 't2' }, 3)
  expect(trips).toEqual([])
  policy.observe(stepStart(), 4)
  expect(trips).toEqual([])
  policy.observe(stepStart(), 5)
  expect(trips).toEqual(['max-steps'])
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

test('history seeding never opens a duration window on its own (a resume starts a fresh one)', () => {
  const trips: BudgetTripReason[] = []
  const history: SessionEvent[] = [
    { type: 'turn/start', turnId: 't1', at: '2026-01-01T00:00:00.000Z' },
    { type: 'step/start', stepId: 's1', turnId: 't1' },
  ]
  // 崩溃前那一回合没有闭合，但墙钟不跨进程累计：恢复后先不开窗口，闲着多久都不算超时。
  const policy = new BudgetPolicy({ limits: { maxDurationMs: 1_000 }, onTrip: reason => trips.push(reason), history, now: 5_000_000 })
  policy.check(9_000_000)
  expect(trips).toEqual([])

  // 真正续跑（新回合）时窗口才开，并从这一刻起算。
  policy.observe({ type: 'turn/start', turnId: 't2' }, 9_000_000)
  policy.check(9_001_001)
  expect(trips).toEqual(['max-duration'])
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
