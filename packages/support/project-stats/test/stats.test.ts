import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { collectProjectStats, countCapabilityKinds, countTestDeclarations, countUnionMembers, parseTestTotal, renderStats } from '../src/index.ts'

const repositoryRoot = join(import.meta.dirname, '..', '..', '..', '..')

test('counts union members including inline ones, and ignores comments', () => {
  const source = [
    'export type SessionEvent =',
    "  | { type: 'step/start'; stepId: string }",
    '  | {',
    "      type: 'user/message'",
    '      text: string',
    '    }',
    "  | {",
    "      /** 注释里的 type: '不是成员' */",
    "      type: 'turn/start'",
    '    }',
    'export type Other = { type: \'not/an/event\' }',
  ].join('\n')
  // 单行成员算，注释里的不算，声明段之外的也不算 —— 顺序与形状都无关
  expect(countUnionMembers(source)).toBe(3)
  expect(countUnionMembers('export const X = 1')).toBe(0)
})

test('counts capability kinds from the closed list', () => {
  const source = "export const CAPABILITY_KINDS = ['llm', 'fs', 'git'] as const"
  expect(countCapabilityKinds(source)).toBe(3)
  expect(countCapabilityKinds('no list here')).toBe(0)
})

test('counts test declarations and sums the vitest totals from a check log', () => {
  expect(countTestDeclarations("test('a', () => {})\nit('b', () => {})")).toBe(2)
  const log = 'Tests  10 passed (10)\n...\nTests  5 passed (5)\n'
  expect(parseTestTotal(log)).toBe(15)
  expect(parseTestTotal('no vitest output')).toBe(0)
})

test('the collector reads the real repository and finds the load-bearing facts', () => {
  const stats = collectProjectStats(repositoryRoot)
  // 这些数字是"规模的量级"，不是精确快照：断言下界，避免每次加包都要改测试
  expect(stats.packages).toBeGreaterThan(25)
  expect(stats.eventKinds).toBeGreaterThan(8)
  expect(stats.capabilityKinds).toBe(8)
  expect(stats.testFiles).toBeGreaterThan(50)
  expect(stats.containerTests).toBeGreaterThan(3)
})

test('docs/stats.md is what the renderer produces (no hand-edited numbers)', () => {
  const stats = collectProjectStats(repositoryRoot)
  const committed = readFileSync(join(repositoryRoot, 'docs', 'stats.md'), 'utf8')
  // 生成时间与"最近一次测试数"是运行期事实，比较时把它们抹掉
  const strip = (markdown: string): string => markdown
    .replace(/^生成时间：.*$/m, '生成时间：<runtime>')
    .replace(/\| 测试通过数（最近一次全量检查） \| \d+ \|/, '| 测试通过数（最近一次全量检查） | <runtime> |')
  const regenerated = renderStats(stats, { at: '生成时间占位', tests: 0 })
  expect(strip(committed)).toBe(strip(regenerated))
})

test('a scratch repository without the expected files degrades to zeros instead of throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'cubus-stats-'))
  mkdirSync(join(root, 'packages', 'core', 'demo'), { recursive: true })
  writeFileSync(join(root, 'packages', 'core', 'demo', 'package.json'), '{}\n')
  const stats = collectProjectStats(root)
  expect(stats.packages).toBe(1)
  expect(stats.eventKinds).toBe(0)
  expect(stats.evals).toEqual([])
})