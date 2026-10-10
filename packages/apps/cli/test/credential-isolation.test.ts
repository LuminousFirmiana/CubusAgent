import { expect, test } from 'vitest'
import { LocalCredentials } from '@cubus/credentials'
import { MODEL_CREDENTIAL_NAME } from '@cubus/llm-deepseek'
import { LocalSubprocess } from '@cubus/tools'

/**
 * C3 拒绝测试（留在 CLI 侧）：凭据"存在"不等于子进程能看见它。
 * 模型接线本身的测试在 @cubus/llm-deepseek（env 优先级、租约、不泄漏 key）。
 */
test('a credential value never reaches a spawned command environment', async () => {
  const credentials = new LocalCredentials({
    sources: { [MODEL_CREDENTIAL_NAME]: () => 'sk-must-not-leak' },
  })
  const lease = await credentials.issue({ name: MODEL_CREDENTIAL_NAME, kind: 'env' })
  expect(lease.reveal()).toBe('sk-must-not-leak')
  await lease.release()

  process.env['DEEPSEEK_API_KEY'] = 'sk-must-not-leak'
  try {
    const result = await new LocalSubprocess().run('printenv DEEPSEEK_API_KEY', {
      cwd: process.cwd(),
      signal: new AbortController().signal,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).not.toContain('sk-must-not-leak')
  } finally {
    delete process.env['DEEPSEEK_API_KEY']
  }
})
