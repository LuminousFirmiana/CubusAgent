import { join } from 'node:path'
import { LocalCredentials } from '@cubus/credentials'
import type { LlmAdapter } from '@cubus/llm'
import {
  createDeepSeekAdapterFactory,
  MODEL_CREDENTIAL_NAME,
  readDeepSeekEnvironment,
} from '@cubus/llm-deepseek'

/**
 * 真模型评测的公共装配（run.ts 与 golden.ts 共用）。
 * 本文件位于 packages/evals/evals/src，仓库根要上溯四级
 * （src -> evals -> evals 组 -> packages -> 仓库根）——不依赖 cwd。
 */
export const repositoryRoot = join(import.meta.dirname, '..', '..', '..', '..')

/**
 * 读模型设置（进程环境优先，其次仓库根 .env；**不修改 process.env**）。
 * 缺 key 时返回 undefined，由调用方报明确错误（不在这里 process.exit，便于测试）。
 */
export async function readSettings(): Promise<{ apiKey?: string; model: string; baseUrl?: string }> {
  const settings = await readDeepSeekEnvironment(process.env, join(repositoryRoot, '.env'))
  return {
    ...(settings.DEEPSEEK_API_KEY === undefined ? {} : { apiKey: settings.DEEPSEEK_API_KEY }),
    model: settings.DEEPSEEK_MODEL ?? 'deepseek-chat',
    ...(settings.DEEPSEEK_BASE_URL === undefined ? {} : { baseUrl: settings.DEEPSEEK_BASE_URL }),
  }
}

/**
 * 适配器工厂：走凭据租约（C3 纪律，与 CLI/工作台同一份实现）。
 * **不在这里包重试**（F4b）：重试由循环做，这样每次重试都写进日志。
 */
export async function createAdapterFactory(apiKey: string, model: string): Promise<() => LlmAdapter> {
  const credentials = new LocalCredentials({ sources: { [MODEL_CREDENTIAL_NAME]: () => apiKey } })
  return await createDeepSeekAdapterFactory({
    credentials,
    settings: {
      DEEPSEEK_MODEL: model,
      ...(process.env['DEEPSEEK_BASE_URL'] === undefined ? {} : { DEEPSEEK_BASE_URL: process.env['DEEPSEEK_BASE_URL'] }),
    },
  })
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
