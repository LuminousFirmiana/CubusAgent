import { isAbsolute, join } from 'node:path'

/**
 * CLI 的路径策略（P1 之后 DeepSeek 的 env/凭据接线统一在 @cubus/llm-deepseek）。
 */

/** 仓库根的 .env：本文件位于 packages/apps/cli/src，上溯四级。不依赖 cwd。 */
export function defaultEnvFile(): string {
  return join(import.meta.dirname, '..', '..', '..', '..', '.env')
}

export function resolveCliPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path)
}
