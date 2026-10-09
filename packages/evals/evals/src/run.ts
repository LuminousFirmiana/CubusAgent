/**
 * 真模型评测入口（S2.2d / S4.6）：
 *   echo 'DEEPSEEK_API_KEY=sk-...' > .env   # 仓库根
 *   pnpm run eval:real                      # 跑全部 fixture
 *   pnpm run eval:real -- add-bug           # 只跑一个 fixture
 * 可选：DEEPSEEK_BASE_URL、DEEPSEEK_MODEL。
 *
 * 结果追加到 packages/evals/evals/EVALS.md（保留历史，便于看回归）。
 * 无 key 的假模型门禁在 CI 每次 push 运行，见 test/fixtures.test.ts。
 */
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekAdapter } from '@cubus/llm'
import { withLlmRetry } from '@cubus/llm-retry'
import { loadFixtures } from './fixtures.ts'
import { runRepairTask } from './harness.ts'

// 加载仓库根的 .env：本文件位于 packages/evals/evals/src，
// 上溯四级（src -> evals -> evals 组 -> packages -> 仓库根）。
// 不依赖 cwd —— 无论从哪里启动本脚本都能找到。
const rootDir = join(import.meta.dirname, '..', '..', '..', '..')
try {
  const raw = readFileSync(join(rootDir, '.env'), 'utf8')
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    const name = match?.[1]
    if (match && name !== undefined && process.env[name] === undefined) {
      process.env[name] = match[2] ?? ''
    }
  }
} catch {
  // 没有 .env：让下面的 key 检查报出明确错误
}

const apiKey = process.env['DEEPSEEK_API_KEY']
if (!apiKey) {
  console.error('DEEPSEEK_API_KEY is required')
  process.exit(2)
}

const model = process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat'
// pnpm run 会把分隔符 -- 原样传给脚本（与 CLI 入口同一个坑），先剥掉。
const args = process.argv.slice(2)
if (args[0] === '--') args.shift()
const filter = args[0]
const all = await loadFixtures()
const selected = filter === undefined ? all : all.filter(fixture => fixture.spec.id === filter)
if (selected.length === 0) {
  console.error('no fixture matches ' + JSON.stringify(String(filter)) + '; available: ' + all.map(f => f.spec.id).join(', '))
  process.exit(2)
}

interface FixtureOutcome {
  id: string
  title: string
  bugKind: string
  passed: boolean
  durationMs: number
  logPath: string
}

const outcomes: FixtureOutcome[] = []
for (const fixture of selected) {
  const workDir = mkdtempSync(join(tmpdir(), 'cubus-eval-' + fixture.spec.id + '-'))
  cpSync(fixture.dir, join(workDir, 'repo'), { recursive: true })
  const startedAt = Date.now()
  const result = await runRepairTask({
    repoDir: join(workDir, 'repo'),
    sessionsDir: join(workDir, 'sessions'),
    adapterFactory: () => withLlmRetry(
      new DeepSeekAdapter({
        baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
        apiKey,
        model,
      }),
      { maxAttempts: 3 },
    ),
    testCommand: fixture.spec.testCommand,
  })
  const durationMs = Date.now() - startedAt
  outcomes.push({
    id: fixture.spec.id,
    title: fixture.spec.title,
    bugKind: fixture.spec.bugKind,
    passed: result.passed,
    durationMs,
    logPath: result.logPath,
  })
  console.log(
    (result.passed ? 'PASS' : 'FAIL') + '  ' +
    fixture.spec.id.padEnd(20) + ' ' +
    (durationMs / 1000).toFixed(1) + 's  ' +
    fixture.spec.title,
  )
}

const passed = outcomes.filter(outcome => outcome.passed).length
const percentage = Math.round((passed / outcomes.length) * 100)
const totalSeconds = (outcomes.reduce((sum, outcome) => sum + outcome.durationMs, 0) / 1000).toFixed(1)

const lines: string[] = []
lines.push('## ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC · ' + model +
  ' · ' + String(outcomes.length) + ' fixtures · ' + String(passed) + '/' + String(outcomes.length) +
  ' passed (' + String(percentage) + '%)')
lines.push('')
lines.push('| fixture | bug 类型 | 结果 | 耗时 | 会话日志 |')
lines.push('|---|---|---|---|---|')
for (const outcome of outcomes) {
  lines.push('| ' + outcome.id + ' | ' + outcome.bugKind + ' | ' + (outcome.passed ? '✅' : '❌') +
    ' | ' + (outcome.durationMs / 1000).toFixed(1) + 's | ' + outcome.logPath + ' |')
}
lines.push('')
lines.push('总耗时 ' + totalSeconds + 's。未通过项需人工看日志定位（会话日志即完整轨迹）。')
lines.push('')

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

console.log('')
console.log(String(passed) + '/' + String(outcomes.length) + ' passed (' + String(percentage) + '%) · model ' + model)
console.log('score table: ' + scorePath)
process.exit(passed === outcomes.length ? 0 : 1)
