/**
 * golden 生成（D4）：**显式重算**，不自动刷新。
 *   pnpm run eval:golden -- --task add-bug
 *
 * 两条纪律：
 * 1. 任务判分必须通过，否则拒绝生成 —— 不能把"回归后的行为"固化成 golden；
 * 2. 覆盖旧 golden 时打印 diff，供人审（避免"顺手刷新"把回归掩盖掉）。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repairEvalRecipe } from '@cubus/recipe-repair-eval'
import { copyFixtureRepo, loadFixtures } from './fixtures.ts'
import {
  compareFingerprints,
  goldenPathFor,
  parseGolden,
  renderFingerprintComparison,
  renderGolden,
} from './fingerprint.ts'
import { runRepairTask } from './harness.ts'
import { createAdapterFactory, optionValue, readSettings, scriptArgs } from './model.ts'
import { loadSuite } from './suites.ts'

const settings = await readSettings()
if (settings.apiKey === undefined) {
  console.error('DEEPSEEK_API_KEY is required (process environment or repository .env)')
  process.exit(2)
}
const apiKey = settings.apiKey
const model = settings.model
const adapterFactory = await createAdapterFactory(apiKey, model)
const args = scriptArgs()

const taskId = optionValue(args, '--task')
if (taskId === undefined) {
  console.error('usage: pnpm run eval:golden -- --task <fixture-id> [--suite <id>]')
  process.exit(2)
}
const suiteId = optionValue(args, '--suite') ?? repairEvalRecipe.manifest.evaluation?.suite
if (suiteId === undefined) {
  console.error('repair-eval recipe does not declare an evaluation suite; pass --suite <id>')
  process.exit(2)
}

const suite = await loadSuite(suiteId)
const task = suite.tasks.find(candidate => candidate.id === taskId)
if (task === undefined) {
  console.error('task ' + taskId + ' is not part of suite ' + suite.id)
  process.exit(2)
}
const fixture = (await loadFixtures()).find(candidate => candidate.spec.id === taskId)
if (fixture === undefined) {
  console.error('unknown fixture: ' + taskId)
  process.exit(2)
}

const workDir = mkdtempSync(join(tmpdir(), 'cubus-golden-' + taskId + '-'))
// 同 run.ts：工作区里不能出现评分元数据
await copyFixtureRepo(fixture, join(workDir, 'repo'))
const result = await runRepairTask({
  repoDir: join(workDir, 'repo'),
  sessionsDir: join(workDir, 'sessions'),
  adapterFactory,
  testCommand: fixture.spec.testCommand,
})

if (!result.passed) {
  console.error('task ' + taskId + ' did not pass; refusing to record a golden from a failing run')
  console.error(result.testOutput)
  process.exit(1)
}

const path = goldenPathFor(fixture.dir)
const previous = existsSync(path) ? parseGolden(readFileSync(path, 'utf8'), path) : undefined
writeFileSync(path, renderGolden(result.fingerprint), 'utf8')

console.log('model: ' + model)
console.log('golden written: ' + path)
console.log('  tools: [' + result.fingerprint.tools.join(', ') + ']')
console.log('  files: [' + result.fingerprint.files.map(file => file.path + ':' + file.kind).join(', ') + ']')
if (previous !== undefined) {
  console.log('')
  console.log('diff against the previous golden:')
  console.log(renderFingerprintComparison(
    previous,
    result.fingerprint,
    compareFingerprints(previous, result.fingerprint, task.gate ?? 'guardrails'),
  ))
}
console.log('')
console.log('session log (artifact, not committed): ' + result.logPath)
