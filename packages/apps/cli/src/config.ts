import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export interface DeepSeekEnvironment {
  DEEPSEEK_API_KEY?: string
  DEEPSEEK_BASE_URL?: string
  DEEPSEEK_MODEL?: string
}

function parseEnvFile(raw: string): DeepSeekEnvironment {
  const result: DeepSeekEnvironment = {}
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    const name = match?.[1]
    const value = match?.[2]
    if (name === 'DEEPSEEK_API_KEY' && value !== undefined) result.DEEPSEEK_API_KEY = value
    if (name === 'DEEPSEEK_BASE_URL' && value !== undefined) result.DEEPSEEK_BASE_URL = value
    if (name === 'DEEPSEEK_MODEL' && value !== undefined) result.DEEPSEEK_MODEL = value
  }
  return result
}

/** Load model settings without mutating process.env or exposing unrelated credentials. */
export async function loadDeepSeekEnvironment(
  environment: NodeJS.ProcessEnv,
  envFile: string,
): Promise<DeepSeekEnvironment> {
  let fileValues: DeepSeekEnvironment = {}
  try {
    fileValues = parseEnvFile(await readFile(envFile, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const apiKey = environment['DEEPSEEK_API_KEY'] ?? fileValues.DEEPSEEK_API_KEY
  const baseUrl = environment['DEEPSEEK_BASE_URL'] ?? fileValues.DEEPSEEK_BASE_URL
  const model = environment['DEEPSEEK_MODEL'] ?? fileValues.DEEPSEEK_MODEL
  return {
    ...(apiKey === undefined ? {} : { DEEPSEEK_API_KEY: apiKey }),
    ...(baseUrl === undefined ? {} : { DEEPSEEK_BASE_URL: baseUrl }),
    ...(model === undefined ? {} : { DEEPSEEK_MODEL: model }),
  }
}

export function defaultEnvFile(): string {
  return join(import.meta.dirname, '..', '..', '..', '..', '.env')
}

export function resolveCliPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}
