import { expect, test } from 'vitest'
import { renderLatestResult } from '../src/results.ts'

/**
 * 分数表渲染（纯函数）：跑飞与答错必须能区分。
 * 被预算拦住的任务带 budgetTripped，机器可读结果里也要保留它。
 */
test('a budget-cancelled outcome stays distinguishable in the machine-readable result', () => {
  const rendered = renderLatestResult({
    ranAt: '2026-10-09T00:00:00.000Z',
    model: 'deepseek-chat',
    suiteId: 'repair-eval-v1',
    suiteVersion: '1',
    passed: 1,
    total: 2,
    outcomes: [
      { id: 'add-bug', passed: true, durationMs: 1000, logPath: '/tmp/a/session.jsonl' },
      {
        id: 'runaway',
        passed: false,
        durationMs: 2000,
        logPath: '/tmp/b/session.jsonl',
        budgetTripped: 'max-steps',
        tokens: { total: 10, cached: 0 },
      },
    ],
  })

  const parsed = JSON.parse(rendered) as { outcomes: { id: string; budgetTripped?: string }[] }
  expect(parsed.outcomes[0]?.budgetTripped).toBeUndefined()
  expect(parsed.outcomes[1]?.budgetTripped).toBe('max-steps')
  expect(rendered.endsWith('\n')).toBe(true)
})
