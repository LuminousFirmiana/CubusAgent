import { expect, test } from 'vitest'
import { summarizeMetrics } from '@cubus/sdk'
import type { SessionMetrics } from '@cubus/sdk'
import { parseMetricsCommand, renderMetricsReport } from '../src/metrics.ts'

function session(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    sessionId: 'abcdef123456',
    events: 10,
    turns: 1,
    cancelledTurns: 0,
    settledTurns: 0,
    steps: 2,
    toolCalls: 4,
    toolFailures: 1,
    toolDenials: 1,
    toolCallsByName: { bash: 3, read_file: 1 },
    tokens: { prompt: 1_000, completion: 100, total: 1_100, cached: 750 },
    usageMessages: 2,
    retries: 1,
    durationMs: { turns: 2, total: 4_000, max: 3_000 },
    needsSettlement: false,
    ...overrides,
  }
}

test('the report is deterministic and shows the real numbers', () => {
  const report = renderMetricsReport(summarizeMetrics([session()]), '/tmp/sessions')

  expect(report).toContain('sessions: 1  (/tmp/sessions)')
  expect(report).toContain('turns:    1  (cancelled 0 -> 0.0%')
  expect(report).toContain('tools:    4  (failed 1 -> 25.0%, denied by approval 1 -> 25.0%)')
  expect(report).toContain('tokens:   1,100  (prompt 1,000 / completion 100 / cached 750 -> 75.0% of prompt)')
  expect(report).toContain('per response: 550 tokens  (2 responses with usage)')
  expect(report).toContain('by tool:  bash 3, read_file 1')
  // F4b 之后这两项也算得出来了：重试写进日志、回合带时间戳
  expect(report).toContain('retries:  1  (50.0% of model requests)')
  expect(report).toContain('turn time: 2.0s  (slowest 3.0s, 2 timed turns)')
  // 同样的输入 -> 同样的输出（可当基线）
  expect(renderMetricsReport(summarizeMetrics([session()]), '/tmp/sessions')).toBe(report)
})

test('an empty corpus says n/a instead of pretending zero', () => {
  const report = renderMetricsReport(summarizeMetrics([]), '/tmp/empty')
  expect(report).toContain('sessions: 0')
  expect(report).toContain('denied by approval 0 -> n/a')
  expect(report).toContain('per response: n/a tokens  (0 responses with usage)')
  expect(report).toContain('retries:  0  (n/a of model requests)')
  expect(report).toContain('turn time: n/a')
  expect(report).toContain('by tool:  (none)')
})

test('a session that needs settlement is flagged in the per-session list', () => {
  const report = renderMetricsReport(summarizeMetrics([session({ needsSettlement: true })]), '/tmp/sessions')
  expect(report).toContain('待恢复')
})

test('the command line takes an explicit sessions dir or falls back to the config', () => {
  expect(parseMetricsCommand(['--sessions', '/tmp/x'], undefined)).toEqual({ sessionsDir: '/tmp/x', json: false })
  expect(parseMetricsCommand(['--', '--json'], '/tmp/from-config')).toEqual({ sessionsDir: '/tmp/from-config', json: true })
  expect(() => parseMetricsCommand([], undefined))
    .toThrow('no sessions directory: pass --sessions <dir> or set "sessionsDir" in ~/.cubus/config.json')
  expect(() => parseMetricsCommand(['--sessions'], '/tmp/x')).toThrow('--sessions requires a value')
  expect(() => parseMetricsCommand(['--nope'], '/tmp/x')).toThrow('unknown option: --nope')
})
