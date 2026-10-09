import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadFixtures } from './fixtures.ts'
import type { Fixture } from './fixtures.ts'

/**
 * Eval Suite（D2；设计见 docs/design/eval-suite-and-resume.md §3）。
 *
 * 之前任务集靠**扫目录**，suite id 只活在两处代码里靠一个 assert 对齐。
 * 现在 suite 是显式制品：命名 + 版本 + 判分方式 + 任务清单（含每任务的门禁档位）。
 */

/** 回归门禁档位（D4 用）：strict = 工具序列完全一致；subsequence = golden 的工具按序出现；none = 只看判分。 */
export type EvalGateLevel = 'strict' | 'subsequence' | 'none'

export interface EvalTaskRef {
  readonly id: string
  /** 缺省 'subsequence'。 */
  readonly gate?: EvalGateLevel
}

export interface EvalSuite {
  readonly id: string
  readonly version: string
  /** v1 只有一种判据：跑任务的 testCommand，exit 0 即通过。 */
  readonly judge: 'hidden-tests'
  readonly tasks: readonly EvalTaskRef[]
}

export class EvalSuiteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvalSuiteError'
  }
}

const GATE_LEVELS: readonly EvalGateLevel[] = ['strict', 'subsequence', 'none']

export function suitesRoot(): string {
  return join(import.meta.dirname, '..', 'fixtures', 'suites')
}

/** 校验套件清单自身（纯函数：文件内容坏了要立刻说清楚是哪一份）。 */
export function validateSuite(suite: EvalSuite, source: string = suite.id): void {
  if (typeof suite.id !== 'string' || suite.id.trim() === '') {
    throw new EvalSuiteError(source + ': suite id must be a non-empty string')
  }
  if (typeof suite.version !== 'string' || suite.version.trim() === '') {
    throw new EvalSuiteError(source + ': suite version must be a non-empty string')
  }
  if (suite.judge !== 'hidden-tests') {
    throw new EvalSuiteError(source + ': unsupported judge: ' + String(suite.judge))
  }
  if (!Array.isArray(suite.tasks) || suite.tasks.length === 0) {
    throw new EvalSuiteError(source + ': suite must list at least one task')
  }
  const seen = new Set<string>()
  for (const task of suite.tasks) {
    if (typeof task.id !== 'string' || task.id.trim() === '') {
      throw new EvalSuiteError(source + ': task id must be a non-empty string')
    }
    if (seen.has(task.id)) {
      throw new EvalSuiteError(source + ': duplicate task: ' + task.id)
    }
    seen.add(task.id)
    if (task.gate !== undefined && !GATE_LEVELS.includes(task.gate)) {
      throw new EvalSuiteError(source + ': unsupported gate for ' + task.id + ': ' + String(task.gate))
    }
  }
}

export async function loadSuites(): Promise<EvalSuite[]> {
  const root = suitesRoot()
  const entries = await readdir(root, { withFileTypes: true })
  const suites: EvalSuite[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const suite = JSON.parse(await readFile(join(root, entry.name), 'utf8')) as EvalSuite
    validateSuite(suite, entry.name)
    suites.push(suite)
  }
  suites.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return suites
}

/** 按 id 取套件；不存在时给出可选清单（错误信息要可执行）。 */
export async function loadSuite(id: string): Promise<EvalSuite> {
  const suites = await loadSuites()
  const suite = suites.find(candidate => candidate.id === id)
  if (suite === undefined) {
    throw new EvalSuiteError(
      'eval suite not found: ' + id + ' (available: ' +
      (suites.length === 0 ? 'none' : suites.map(candidate => candidate.id).join(', ')) + ')',
    )
  }
  return suite
}

/** 套件任务 -> 夹具（顺序按套件清单；声明的任务必须真实存在）。 */
export function resolveSuiteTasks(
  suite: EvalSuite,
  fixtures: readonly Fixture[],
): readonly Fixture[] {
  const byId = new Map(fixtures.map(fixture => [fixture.spec.id, fixture]))
  return suite.tasks.map(task => {
    const fixture = byId.get(task.id)
    if (fixture === undefined) {
      throw new EvalSuiteError('suite ' + suite.id + ' references unknown task: ' + task.id)
    }
    return fixture
  })
}

export async function loadSuiteTasks(id: string): Promise<{ suite: EvalSuite, fixtures: readonly Fixture[] }> {
  const suite = await loadSuite(id)
  const fixtures = await loadFixtures()
  return { suite, fixtures: resolveSuiteTasks(suite, fixtures) }
}

/**
 * 评测 harness 的入口校验：recipe 声明的套件必须真实注册，否则拒绝计分。
 * 这就是 D1 设计里"评测运行时校验"的落点（不引入 ctx 服务：评测上下文本身就是 harness）。
 */
export async function assertSuiteRegistered(
  recipeId: string,
  declaredSuite: string | undefined,
): Promise<EvalSuite> {
  if (declaredSuite === undefined) {
    throw new EvalSuiteError('recipe ' + recipeId + ' does not declare an evaluation suite')
  }
  return await loadSuite(declaredSuite)
}
