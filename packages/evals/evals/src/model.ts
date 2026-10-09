import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekAdapter } from '@cubus/llm'
import { withLlmRetry } from '@cubus/llm-retry'
import type { LlmAdapter } from '@cubus/llm'

/**
 * 真模型评测的公共装配（run.ts 与 golden.ts 共用）。
 * 本文件位于 packages/evals/evals/src，仓库根要上溯四级
 * （src -> evals -> evals 组 -> packages -> 仓库根）——不依赖 cwd。
 */
export const repositoryRoot = join(import.meta.dirname, '..', '..', '..', '..')

/** 加载仓库根 .env（不覆盖已存在的环境变量）。缺失时静默，让 key 检查报明确错误。 */
export function loadEnvFile(): void {
  try {
    const raw = readFileSync(join(repositoryRoot, '.env'), 'utf8')
    for (const line of raw.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      const name = match?.[1]
      if (match && name !== undefined && process.env[name] === undefined) {
        process.env[name] = match[2] ?? ''
      }
    }
  } catch {
    // 没有 .env：交给 requireApiKey 报错
  }
}

export function requireApiKey(): string {
  const apiKey = process.env['DEEPSEEK_API_KEY']
  if (!apiKey) {
    console.error('DEEPSEEK_API_KEY is required')
    process.exit(2)
  }
  return apiKey
}

export function modelName(): string {
  return process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat'
}

/** 每个任务一份适配器实例（含重试包装）。 */
export function createAdapterFactory(apiKey: string, model: string): () => LlmAdapter {
  return () => withLlmRetry(
    new DeepSeekAdapter({
      baseUrl: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com',
      apiKey,
      model,
    }),
    { maxAttempts: 3 },
  )
}

/** pnpm run 会把分隔符 -- 原样传给脚本（与 CLI 入口同一个坑），先剥掉。 */
export function scriptArgs(): string[] {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  return args
}

export function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(name + ' requires a value')
    process.exit(2)
  }
  return value
}
