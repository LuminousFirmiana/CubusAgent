/**
 * 真模型评测入口（S2.2d）：
 *   echo 'DEEPSEEK_API_KEY=sk-...' > .env   # 仓库根
 *   pnpm run eval:real
 * 可选：DEEPSEEK_BASE_URL、DEEPSEEK_MODEL。
 */
import { cpSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekAdapter } from '@cubus/llm'
import { withLlmRetry } from '@cubus/llm-retry'
import { CODING_AGENT_PROMPT, runRepairTask } from './harness.ts'

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

// fixture 是"永远带 bug"的原样仓库：任务在临时副本上跑，原样永不被动。
const fixtureDir = join(import.meta.dirname, '..', 'fixtures', 'bug-repos', 'add-bug')
const workDir = mkdtempSync(join(tmpdir(), 'cubus-eval-work-'))
cpSync(fixtureDir, join(workDir, 'repo'), { recursive: true })
const repoDir = join(workDir, 'repo')
const sessionsDir = mkdtempSync(join(tmpdir(), 'cubus-eval-'))

const result = await runRepairTask({
  repoDir,
  sessionsDir,
  adapterFactory: () =>
    withLlmRetry(
      new DeepSeekAdapter({
        baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
        apiKey,
        model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
      }),
      { maxAttempts: 3 },
    ),
  systemPrompt: CODING_AGENT_PROMPT,
})

console.log(JSON.stringify({
  passed: result.passed,
  assistantText: result.assistantText,
  logPath: result.logPath,
  testOutput: result.testOutput,
}, null, 2))

process.exit(result.passed ? 0 : 1)
