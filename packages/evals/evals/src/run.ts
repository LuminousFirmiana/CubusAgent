/**
 * 真模型评测入口（S2.2d / S4.6 / D2）：
 *   echo 'DEEPSEEK_API_KEY=sk-...' > .env   # 仓库根
 *   pnpm run eval:real                      # 跑 recipe 声明的那套 suite
 *   pnpm run eval:real -- --suite <id>      # 指定套件
 *   pnpm run eval:real -- --task <fixture>  # 只跑套件里的某一个任务
 * 可选：DEEPSEEK_BASE_URL、DEEPSEEK_MODEL。
 *
 * 结果写两份：EVALS.md（人读，追加）+ evals-latest.json（机器可读，供 D4 门禁与工作台）。
 * 无 key 的假模型门禁在 CI 每次 push 运行，见 test/fixtures.test.ts。
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairEvalRecipe } from '@cubus/recipe-repair-eval'
import { sessionMetrics } from '@cubus/sdk'
import { copyFixtureRepo } from './fixtures.ts'
import { compareFingerprints, goldenPathFor, parseGolden } from './fingerprint.ts'
import { runRepairTask } from './harness.ts'
import { createAdapterFactory, loadEnvFile, modelName, optionValue, requireApiKey, scriptArgs } from './model.ts'
import { renderLatestResult } from './results.ts'
import { loadSuiteTasks } from './suites.ts'

loadEnvFile()
const apiKey = requireApiKey()
const model = modelName()
const args = scriptArgs()

/**
 * 任务集来自 **suite 清单**（D2），不再靠扫目录：
 *   pnpm run eval:real                      # 跑 recipe 声明的那套 suite
 *   pnpm run eval:real --suite <id>         # 指定套件
 *   pnpm run eval:real --task <fixture-id>  # 只跑套件里的某一个任务
 */
const declaredSuite = repairEvalRecipe.manifest.evaluation?.suite
const suiteId = optionValue(args, '--suite') ?? declaredSuite
if (suiteId === undefined) {
  console.error('repair-eval recipe does not declare an evaluation suite; pass --suite <id>')
  process.exit(2)
}

let suite: Awaited<ReturnType<typeof loadSuiteTasks>>
try {
  suite = await loadSuiteTasks(suiteId)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}
const taskFilter = optionValue(args, '--task')
const selected = taskFilter === undefined
  ? suite.fixtures
  : suite.fixtures.filter(fixture => fixture.spec.id === taskFilter)
if (selected.length === 0) {
  console.error(
    'no task matches ' + JSON.stringify(String(taskFilter)) + '; suite ' + suite.suite.id + ' has: ' +
    suite.fixtures.map(fixture => fixture.spec.id).join(', '),
  )
  process.exit(2)
}
console.log('suite: ' + suite.suite.id + ' v' + suite.suite.version + ' (' + String(selected.length) + '/' + String(suite.fixtures.length) + ' tasks)')

interface FixtureOutcome {
  id: string
  title: string
  bugKind: string
  passed: boolean
  durationMs: number
  logPath: string
  /** 与 golden 的门禁对比（没有 golden 的任务缺省）。 */
  regression?: { ok: boolean; differences: readonly string[] }
  /** 本任务的 token 用量（与分数同一张表）。 */
  tokens: { total: number; cached: number }
}

const outcomes: FixtureOutcome[] = []
for (const fixture of selected) {
  const workDir = mkdtempSync(join(tmpdir(), 'cubus-eval-' + fixture.spec.id + '-'))
  // 复制时排除评分元数据（fixture.json/golden.json）：工作区里不该有答案
  await copyFixtureRepo(fixture, join(workDir, 'repo'))
  const startedAt = Date.now()
  const result = await runRepairTask({
    repoDir: join(workDir, 'repo'),
    sessionsDir: join(workDir, 'sessions'),
    adapterFactory: createAdapterFactory(apiKey, model),
    testCommand: fixture.spec.testCommand,
  })
  const durationMs = Date.now() - startedAt

  // 回归门禁（D4）：有 golden 就比行为指纹（判分 / 文件集 / 工具序列 / 调用预算）。
  const goldenPath = goldenPathFor(fixture.dir)
  const gate = suite.suite.tasks.find(task => task.id === fixture.spec.id)?.gate ?? 'guardrails'
  const regression = existsSync(goldenPath)
    ? compareFingerprints(
        parseGolden(readFileSync(goldenPath, 'utf8'), goldenPath),
        result.fingerprint,
        gate,
      )
    : undefined

  // 指标（F4）：从同一份日志算 token，与判分结果并排放进分数表
  const metrics = sessionMetrics(fixture.spec.id, result.turnEvents)
  outcomes.push({
    id: fixture.spec.id,
    title: fixture.spec.title,
    bugKind: fixture.spec.bugKind,
    passed: result.passed,
    durationMs,
    logPath: result.logPath,
    tokens: { total: metrics.tokens.total, cached: metrics.tokens.cached },
    ...(regression === undefined ? {} : { regression: { ok: regression.ok, differences: regression.differences } }),
  })
  console.log(
    (result.passed ? 'PASS' : 'FAIL') + '  ' +
    fixture.spec.id.padEnd(20) + ' ' +
    (durationMs / 1000).toFixed(1) + 's  ' +
    fixture.spec.title,
  )
  if (regression !== undefined && !regression.ok) {
    console.log('      gate FAIL: ' + regression.differences.join('; '))
  }
}

const passed = outcomes.filter(outcome => outcome.passed).length
const percentage = Math.round((passed / outcomes.length) * 100)
const totalSeconds = (outcomes.reduce((sum, outcome) => sum + outcome.durationMs, 0) / 1000).toFixed(1)

const lines: string[] = []
lines.push('## ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC · ' + model +
  ' · ' + String(outcomes.length) + ' fixtures · ' + String(passed) + '/' + String(outcomes.length) +
  ' passed (' + String(percentage) + '%)')
lines.push('')
lines.push('| fixture | bug 类型 | 结果 | 门禁 | token | 耗时 | 会话日志 |')
lines.push('|---|---|---|---|---|---|---|')
for (const outcome of outcomes) {
  const gate = outcome.regression === undefined ? '—' : (outcome.regression.ok ? '✅' : '❌ ' + outcome.regression.differences.join('; '))
  lines.push('| ' + outcome.id + ' | ' + outcome.bugKind + ' | ' + (outcome.passed ? '✅' : '❌') +
    ' | ' + gate + ' | ' + outcome.tokens.total + ' (' + outcome.tokens.cached + ' cached)' +
    ' | ' + (outcome.durationMs / 1000).toFixed(1) + 's | ' + outcome.logPath + ' |')
}
lines.push('')
lines.push('token 合计 ' + String(outcomes.reduce((sum, outcome) => sum + outcome.tokens.total, 0)) + '（缓存 ' +
  String(outcomes.reduce((sum, outcome) => sum + outcome.tokens.cached, 0)) + '）—— 与分数同一张表，成本可跟分数一起看。')
lines.push('')
lines.push('总耗时 ' + totalSeconds + 's。未通过项需人工看日志定位（会话日志即完整轨迹）。')
lines.push('')
lines[0] = lines[0]!.replace(' fixtures · ', ' tasks (suite ' + suite.suite.id + ' v' + suite.suite.version + ') · ')

const scorePath = join(import.meta.dirname, '..', 'EVALS.md')
if (!existsSync(scorePath)) {
  writeFileSync(scorePath, [
    '# Repair Eval Scores',
    '',
    '真模型修复评测的运行记录（追加式，保留历史）。',
    '无 key 的假模型门禁在每次 push 的 CI 里运行（pnpm run check，见 test/fixtures.test.ts）。',
    '生成命令：pnpm run eval:real（加 -- <fixture-id> 只跑一个）。',
    '',
    '',
  ].join('\n'), 'utf8')
}
appendFileSync(scorePath, lines.join('\n') + '\n', 'utf8')

// 机器可读结果（D2）：D4 的门禁与将来的工作台都读它。
const latestPath = join(import.meta.dirname, '..', 'evals-latest.json')
const gates = new Map(suite.suite.tasks.map(task => [task.id, task.gate]))
writeFileSync(latestPath, renderLatestResult({
  ranAt: new Date().toISOString(),
  model,
  suiteId: suite.suite.id,
  suiteVersion: suite.suite.version,
  passed,
  total: outcomes.length,
  outcomes: outcomes.map(outcome => {
    const gate = gates.get(outcome.id)
    return {
      id: outcome.id,
      passed: outcome.passed,
      durationMs: outcome.durationMs,
      logPath: outcome.logPath,
      ...(gate === undefined ? {} : { gate }),
      ...(outcome.regression === undefined ? {} : { regression: outcome.regression }),
      tokens: outcome.tokens,
    }
  }),
}), 'utf8')

console.log('')
const regressions = outcomes.filter(outcome => outcome.regression !== undefined && !outcome.regression.ok)
console.log('')
console.log(String(passed) + '/' + String(outcomes.length) + ' passed (' + String(percentage) + '%) · model ' + model)
if (regressions.length > 0) {
  console.log(String(regressions.length) + ' regression(s) against golden: ' + regressions.map(o => o.id).join(', '))
}
console.log('score table: ' + scorePath)
console.log('machine-readable: ' + join(import.meta.dirname, '..', 'evals-latest.json'))
// 判分失败或门禁变红都算这次评测没过（回归门禁的意义就在这里）
process.exit(passed === outcomes.length && regressions.length === 0 ? 0 : 1)
