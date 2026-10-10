import type { CredentialsProvider } from '@cubus/credentials'
import { DeepSeekAdapter } from '@cubus/llm'
import type { LlmAdapter } from '@cubus/llm'
import type { DeepSeekEnvironment } from './config.ts'

/** 模型凭据名：CLI 与 Host 的 credentials 能力共用同一个名字（进快照的也只有名字）。 */
export const MODEL_CREDENTIAL_NAME = 'deepseek'

export interface ModelAdapterOptions {
  credentials: CredentialsProvider
  settings: DeepSeekEnvironment
  maxAttempts: number
}

/**
 * 用 credentials seam 构造模型适配器工厂（C3）。
 *
 * CLI 不直接读明文环境变量：明文只通过租约取出、用完立刻 release；
 * 适配器内部也不再持有可序列化的 apiKey（见 DeepSeekAdapter 的 ES 私有字段）。
 */
export async function createModelAdapterFactory(
  options: ModelAdapterOptions,
): Promise<() => LlmAdapter> {
  const lease = await options.credentials.issue({ name: MODEL_CREDENTIAL_NAME, kind: 'env' })
  try {
    const adapter = new DeepSeekAdapter({
      baseUrl: options.settings.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: lease.reveal(),
      model: options.settings.DEEPSEEK_MODEL ?? 'deepseek-chat',
    })
    // 重试由**循环**负责（F4b），这样每次重试都进日志（request/retry）；这里不再套适配器层重试。
    void options.maxAttempts
    return () => adapter
  } finally {
    await lease.release()
  }
}
