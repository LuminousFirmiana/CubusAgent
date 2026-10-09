import { expect, test } from 'vitest'
import { SESSION_FORMAT_VERSION, parseSessionMeta, renderSessionMeta, SessionFormatError } from '../src/meta.ts'
import {
  isSettled,
  planSettlement,
  settlementEvents,
  UNKNOWN_TOOL_RESULT_TEXT,
} from '../src/settle.ts'
import type { SessionEvent } from '../src/types.ts'

function ev(type: SessionEvent['type'], extra: Record<string, unknown> = {}): SessionEvent {
  return { type, ...extra } as SessionEvent
}

test('a closed log needs no settlement', () => {
  const events: SessionEvent[] = [
    ev('turn/start', { turnId: 't1' }),
    ev('step/start', { stepId: 's1', turnId: 't1' }),
    ev('tool/call', { id: 'c1', stepId: 's1', name: 'bash', args: {} }),
    ev('tool/result', { id: 'c1', ok: true, output: { text: 'ok' } }),
    ev('step/end', { stepId: 's1' }),
    ev('turn/end', { turnId: 't1' }),
  ]

  const plan = planSettlement(events)
  expect(plan).toEqual({ unclosedSteps: [], orphanToolCalls: [] })
  expect(isSettled(plan)).toBe(true)
  expect(settlementEvents(plan)).toEqual([])
})

test('a crash mid-tool yields an unknown result plus step and turn closure', () => {
  // 崩溃现场：turn/step 开着，工具调用没有结果
  const events: SessionEvent[] = [
    ev('turn/start', { turnId: 't1' }),
    ev('step/start', { stepId: 's1', turnId: 't1' }),
    ev('tool/call', { id: 'c1', stepId: 's1', name: 'bash', args: { command: 'sleep 60' } }),
  ]

  const plan = planSettlement(events)
  expect(plan).toEqual({
    unclosedTurn: 't1',
    unclosedSteps: ['s1'],
    orphanToolCalls: ['c1'],
  })
  expect(isSettled(plan)).toBe(false)

  // 顺序：孤儿结果 -> step 闭合 -> turn 闭合；标记 settled 以便与正常收尾区分
  expect(settlementEvents(plan)).toEqual([
    { type: 'tool/result', id: 'c1', ok: false, output: { text: UNKNOWN_TOOL_RESULT_TEXT } },
    { type: 'step/end', stepId: 's1', settled: true },
    { type: 'turn/end', turnId: 't1', settled: true },
  ])
})

test('an earlier closed turn does not hide a later open one', () => {
  const events: SessionEvent[] = [
    ev('turn/start', { turnId: 't1' }),
    ev('step/start', { stepId: 's1', turnId: 't1' }),
    ev('step/end', { stepId: 's1' }),
    ev('turn/end', { turnId: 't1' }),
    ev('turn/start', { turnId: 't2' }),
    ev('step/start', { stepId: 's2', turnId: 't2' }),
  ]

  const plan = planSettlement(events)
  expect(plan.unclosedTurn).toBe('t2')
  expect(plan.unclosedSteps).toEqual(['s2'])
  expect(plan.orphanToolCalls).toEqual([])
})

test('a missing meta file reads as format version 1, a newer one is refused', () => {
  expect(parseSessionMeta(undefined)).toEqual({ formatVersion: 1 })

  const meta = { formatVersion: SESSION_FORMAT_VERSION, createdAt: '2026-10-09T00:00:00.000Z', sessionId: 's1', recipe: { id: 'coding-agent', version: '1.0.0' } }
  expect(parseSessionMeta(renderSessionMeta(meta))).toEqual(meta)
  expect(renderSessionMeta(meta).endsWith('\n')).toBe(true)

  expect(() => parseSessionMeta('{ not json')).toThrow(SessionFormatError)
  expect(() => parseSessionMeta('{"formatVersion":0}')).toThrow('formatVersion must be a positive integer')
  // 不静默降级：版本更高就明确拒绝，并提示升级工具而不是降级日志
  expect(() => parseSessionMeta('{"formatVersion":99}')).toThrow('upgrade the tooling instead of downgrading the log')
  expect(() => parseSessionMeta('{"formatVersion":99}')).toThrow(SessionFormatError)
})
