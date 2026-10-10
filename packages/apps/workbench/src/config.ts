import { readFileSync } from 'node:fs'
import type { CredentialsProvider } from '@cubus/credentials'
import { DeepSeekAdapter } from '@cubus/llm'
import type { LlmAdapter } from '@cubus/llm'

/**
 * 工作台的真模型接线（E3）：与 CLI 同构 —— 明文只经 credentials seam 的租约取出，
 * 适配器内部不保留可序列化的 apiKey（见 DeepSeekAdapter 的 ES 私有字段）。
 *
 * 技术债：这段与 packages/apps/cli/src/{config,model}.ts、packages/evals/evals/src/model.ts
 * 是同构的第三份；第 4 个消费者出现时应抽成共享包（已记入 handover）。
 */

/** 模型凭据名：进快照的只有名字，值只存在于取用瞬间。 */
export const MODEL_CREDENTIAL_NAME = 'deepseek'

export interface DeepSeekEnvironment {
  readonly DEEPSEEK_API_KEY?: string
  readonly DEEPSEEK_BASE_URL?: string
  readonly DEEPSEEK_MODEL?: string
}

/** 读仓库/工作目录的 .env 补进 env（不覆盖已存在的变量）。 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    const name = match?.[1]
    if (match && name !== undefined && env[name] === undefined) {
      env[name] = match[2] ?? ''
    }
  }
}

export function readDeepSeekEnvironment(env: NodeJS.ProcessEnv): DeepSeekEnvironment {
  const apiKey = env['DEEPSEEK_API_KEY']
  const baseUrl = env['DEEPSEEK_BASE_URL']
  const model = env['DEEPSEEK_MODEL']
  return {
    ...(apiKey === undefined ? {} : { DEEPSEEK_API_KEY: apiKey }),
    ...(baseUrl === undefined ? {} : { DEEPSEEK_BASE_URL: baseUrl }),
    ...(model === undefined ? {} : { DEEPSEEK_MODEL: model }),
  }
}

export async function createModelAdapterFactory(options: {
  credentials: CredentialsProvider
  settings: DeepSeekEnvironment
  maxAttempts: number
}): Promise<() => LlmAdapter> {
  const lease = await options.credentials.issue({ name: MODEL_CREDENTIAL_NAME, kind: 'env' })
  try {
    const adapter = new DeepSeekAdapter({
      baseUrl: options.settings.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: lease.reveal(),
      model: options.settings.DEEPSEEK_MODEL ?? 'deepseek-chat',
    })
    // 重试由循环负责（F4b）：工作台把 maxAttempts 传给 SessionRuntime 的 retry 选项
    void options.maxAttempts
    return () => adapter
  } finally {
    await lease.release()
  }
}
