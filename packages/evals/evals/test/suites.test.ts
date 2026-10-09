import { expect, test } from 'vitest'
import { loadFixtures } from '../src/fixtures.ts'
import { renderLatestResult } from '../src/results.ts'
import {
  assertSuiteRegistered,
  EvalSuiteError,
  loadSuite,
  loadSuiteTasks,
  loadSuites,
  resolveSuiteTasks,
  validateSuite,
} from '../src/suites.ts'
import type { EvalSuite } from '../src/suites.ts'

const validSuite: EvalSuite = {
  id: 'demo-v1',
  version: '1.0.0',
  judge: 'hidden-tests',
  tasks: [{ id: 'add-bug' }, { id: 'off-by-one', gate: 'strict' }],
}

test('the repair-eval suite is an explicit, versioned artifact', async () => {
  const suite = await loadSuite('repair-eval-v1')

  expect(suite.version).toBe('1.0.0')
  expect(suite.judge).toBe('hidden-tests')
  // 任务清单是显式的：不再靠扫目录
  expect(suite.tasks.map(task => task.id)).toEqual([
    'add-bug',
    'empty-input',
    'in-place-mutation',
    'missing-await',
    'off-by-one',
    'string-coercion',
    'swallowed-error',
  ])
  expect(suite.tasks.every(task => task.gate === 'subsequence')).toBe(true)
})

test('every fixture belongs to a suite so nothing silently falls out of the eval', async () => {
  const suites = await loadSuites()
  const fixtures = await loadFixtures()
  const declared = new Set(suites.flatMap(suite => suite.tasks.map(task => task.id)))

  for (const fixture of fixtures) {
    expect(declared.has(fixture.spec.id)).toBe(true)
  }
})

test('a suite that lists an unknown task, a duplicate task or a bad judge is rejected', async () => {
  expect(() => validateSuite({ ...validSuite, tasks: [{ id: 'ghost-task' }] }, 'demo.json')).not.toThrow()
  // 未知任务在"解析任务"这一步失败（文件系统层面才知道夹具是否存在）
  const fixtures = await loadFixtures()
  expect(() => resolveSuiteTasks({ ...validSuite, tasks: [{ id: 'ghost-task' }] }, fixtures))
    .toThrow('references unknown task: ghost-task')

  expect(() => validateSuite({ ...validSuite, tasks: [{ id: 'a' }, { id: 'a' }] }))
    .toThrow('duplicate task: a')
  expect(() => validateSuite({ ...validSuite, judge: 'vibes' as never }))
    .toThrow('unsupported judge: vibes')
  expect(() => validateSuite({ ...validSuite, tasks: [] })).toThrow('at least one task')
  expect(() => validateSuite({ ...validSuite, tasks: [{ id: 'a', gate: 'loose' as never }] }))
    .toThrow('unsupported gate for a: loose')
})

test('suite task order drives the run order, and unknown suites fail with the available list', async () => {
  const { suite, fixtures } = await loadSuiteTasks('repair-eval-v1')
  expect(fixtures.map(fixture => fixture.spec.id)).toEqual(suite.tasks.map(task => task.id))

  await expect(loadSuite('nope-v9')).rejects.toThrow(EvalSuiteError)
  await expect(loadSuite('nope-v9')).rejects.toThrow('eval suite not found: nope-v9 (available: repair-eval-v1)')
})

test('the harness refuses to score a recipe without a registered suite', async () => {
  // 这就是"评测运行时校验"：拿 A 套件给 B 产品打分会在启动时失败
  await expect(assertSuiteRegistered('repair-eval', undefined))
    .rejects.toThrow('recipe repair-eval does not declare an evaluation suite')
  await expect(assertSuiteRegistered('repair-eval', 'ghost-suite-v1'))
    .rejects.toThrow('eval suite not found: ghost-suite-v1')

  const suite = await assertSuiteRegistered('repair-eval', 'repair-eval-v1')
  expect(suite.id).toBe('repair-eval-v1')
})

test('the machine-readable result carries the suite identity and per-task gates', () => {
  const rendered = renderLatestResult({
    ranAt: '2026-10-09T00:00:00.000Z',
    model: 'deepseek-chat',
    suiteId: 'repair-eval-v1',
    suiteVersion: '1.0.0',
    passed: 1,
    total: 2,
    outcomes: [
      { id: 'add-bug', passed: true, durationMs: 1234, logPath: '/tmp/a/session.jsonl', gate: 'subsequence' },
      { id: 'off-by-one', passed: false, durationMs: 4321, logPath: '/tmp/b/session.jsonl' },
    ],
  })

  expect(JSON.parse(rendered)).toEqual({
    ranAt: '2026-10-09T00:00:00.000Z',
    model: 'deepseek-chat',
    suiteId: 'repair-eval-v1',
    suiteVersion: '1.0.0',
    passed: 1,
    total: 2,
    outcomes: [
      { id: 'add-bug', passed: true, durationMs: 1234, logPath: '/tmp/a/session.jsonl', gate: 'subsequence' },
      { id: 'off-by-one', passed: false, durationMs: 4321, logPath: '/tmp/b/session.jsonl' },
    ],
  })
  expect(rendered.endsWith('\n')).toBe(true)
})
