/**
 * 真模型评测入口（S2.2d）：
 *   DEEPSEEK_API_KEY=sk-... pnpm --filter @cubus/evals run eval:real
 * 可选：DEEPSEEK_BASE_URL、DEEPSEEK_MODEL。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekAdapter } from '@cubus/llm'
import { CODING_AGENT_PROMPT, runRepairTask } from './harness.ts'

const apiKey = process.env['DEEPSEEK_API_KEY']
if (!apiKey) {
  console.error('DEEPSEEK_API_KEY is required')
  process.exit(2)
}

const repoDir = join(import.meta.dirname, 'fixtures', 'bug-repos', 'add-bug')
const sessionsDir = mkdtempSync(join(tmpdir(), 'cubus-eval-'))

const result = await runRepairTask({
  repoDir,
  sessionsDir,
  adapterFactory: () =>
    new DeepSeekAdapter({
      baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
      apiKey,
      model: process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat',
    }),
  systemPrompt: CODING_AGENT_PROMPT,
})

console.log(JSON.stringify({
  passed: result.passed,
  assistantText: result.assistantText,
  logPath: result.logPath,
  testOutput: result.testOutput,
}, null, 2))

process.exit(result.passed ? 0 : 1)
