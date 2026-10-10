import { readFile } from 'node:fs/promises'
import type { CredentialsProvider } from '@cubus/credentials'
import { DeepSeekAdapter } from './deepseek.ts'
import type { LlmAdapter } from '@cubus/llm'

/**
 * DeepSeek 的**接线**（原来在 CLI / 评测 / 工作台各有一份，P1 合并到这里）。
 *
 * 两条纪律：
 * 1. 明文 key 只经 credentials seam 的租约取出，用完立刻 release；适配器内部不保留可序列化的 key；
 * 2. **不修改 process.env**（读 .env 只是"取值"，不是"改环境"）—— 上层要合并自己的配置就显式传进来。
 *
 * 重试**不在这里**：重试属于循环（request/retry 事件），provider 只负责一次请求。
 */

/** 模型凭据名：进装配快照的只有名字，值只存在于取用瞬间。 */
export const MODEL_CREDENTIAL_NAME = 'deepseek'

export interface DeepSeekEnvironment {
  readonly DEEPSEEK_API_KEY?: string
  readonly DEEPSEEK_BASE_URL?: string
  readonly DEEPSEEK_MODEL?: string
}

/** 读 .env 里的三件套；文件不存在返回空对象（不报错）。 */
export async function loadDeepSeekEnvFile(envFile: string): Promise<DeepSeekEnvironment> {
  let raw: string
  try {
    raw = await readFile(envFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const values: { DEEPSEEK_API_KEY?: string; DEEPSEEK_BASE_URL?: string; DEEPSEEK_MODEL?: string } = {}
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    const name = match?.[1]
    const value = match?.[2]
    if (name === undefined || value === undefined) continue
    if (name === 'DEEPSEEK_API_KEY') values.DEEPSEEK_API_KEY = value
    if (name === 'DEEPSEEK_BASE_URL') values.DEEPSEEK_BASE_URL = value
    if (name === 'DEEPSEEK_MODEL') values.DEEPSEEK_MODEL = value
  }
  return values
}

/** 环境变量优先，其次 .env 文件；两者都不改。 */
export async function readDeepSeekEnvironment(
  environment: NodeJS.ProcessEnv,
  envFile: string,
): Promise<DeepSeekEnvironment> {
  const fileValues = await loadDeepSeekEnvFile(envFile)
  const apiKey = environment['DEEPSEEK_API_KEY'] ?? fileValues.DEEPSEEK_API_KEY
  const baseUrl = environment['DEEPSEEK_BASE_URL'] ?? fileValues.DEEPSEEK_BASE_URL
  const model = environment['DEEPSEEK_MODEL'] ?? fileValues.DEEPSEEK_MODEL
  return {
    ...(apiKey === undefined ? {} : { DEEPSEEK_API_KEY: apiKey }),
    ...(baseUrl === undefined ? {} : { DEEPSEEK_BASE_URL: baseUrl }),
    ...(model === undefined ? {} : { DEEPSEEK_MODEL: model }),
  }
}

/**
 * 申请凭据租约并造出适配器工厂。
 * 没有 key 时抛 CredentialsError（调用方据此给出明确提示）。
 */
export async function createDeepSeekAdapterFactory(options: {
  credentials: CredentialsProvider
  settings: DeepSeekEnvironment
}): Promise<() => LlmAdapter> {
  const lease = await options.credentials.issue({ name: MODEL_CREDENTIAL_NAME, kind: 'env' })
  try {
    const adapter = new DeepSeekAdapter({
      baseUrl: options.settings.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      apiKey: lease.reveal(),
      model: options.settings.DEEPSEEK_MODEL ?? 'deepseek-chat',
    })
    return () => adapter
  } finally {
    await lease.release()
  }
}
