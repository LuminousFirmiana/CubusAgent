import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { defaultEnvFile, resolveCliPath } from '../src/index.ts'

/** CLI 只保留路径策略；DeepSeek 的 env/凭据接线已统一到 @cubus/llm-deepseek。 */

test('the default .env points at the repository root, not at the cwd', () => {
  // 本文件位于 packages/apps/cli/test：仓库根要上溯四级。
  // 断言"相对测试文件算出来的仓库根"而不是目录名 —— 目录名是机器相关的（干净副本里叫别的名字）。
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  expect(existsSync(join(repositoryRoot, 'pnpm-workspace.yaml'))).toBe(true)
  expect(defaultEnvFile()).toBe(join(repositoryRoot, '.env'))

  // 真正的契约是"不依赖 cwd"：换个目录再问一次，答案不变
  const before = process.cwd()
  try {
    process.chdir(dirname(repositoryRoot))
    expect(defaultEnvFile()).toBe(join(repositoryRoot, '.env'))
  } finally {
    process.chdir(before)
  }
})

test('resolveCliPath keeps absolute paths and resolves relative ones against the cwd', () => {
  expect(resolveCliPath('/tmp/x', '/tmp')).toBe('/tmp/x')
  expect(resolveCliPath('repo', '/tmp')).toBe(join('/tmp', 'repo'))
})
