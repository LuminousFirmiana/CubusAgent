import { join } from 'node:path'
import { expect, test } from 'vitest'
import { defaultEnvFile, resolveCliPath } from '../src/index.ts'

/** CLI 只保留路径策略；DeepSeek 的 env/凭据接线已统一到 @cubus/llm-deepseek。 */

test('the default .env points at the repository root regardless of cwd', () => {
  const envFile = defaultEnvFile()
  expect(envFile.endsWith(join('CubusAgent', '.env'))).toBe(true)
  expect(envFile.startsWith('/')).toBe(true)
})

test('resolveCliPath keeps absolute paths and resolves relative ones against the cwd', () => {
  expect(resolveCliPath('/tmp/x', '/tmp')).toBe('/tmp/x')
  expect(resolveCliPath('repo', '/tmp')).toBe(join('/tmp', 'repo'))
})
