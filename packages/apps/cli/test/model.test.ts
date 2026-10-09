import { expect, test } from 'vitest'
import { LocalCredentials } from '@cubus/credentials'
import { LocalSubprocess } from '@cubus/tools'
import { createModelAdapterFactory, MODEL_CREDENTIAL_NAME } from '../src/index.ts'

test('builds a DeepSeek adapter from a credential lease without exposing the key', async () => {
  const credentials = new LocalCredentials({
    sources: { [MODEL_CREDENTIAL_NAME]: () => 'sk-from-lease' },
  })

  const factory = await createModelAdapterFactory({
    credentials,
    settings: { DEEPSEEK_MODEL: 'deepseek-chat', DEEPSEEK_BASE_URL: 'https://example.test' },
    maxAttempts: 2,
  })
  const adapter = factory()

  expect(adapter.provider).toBe('deepseek')
  expect(adapter.model).toBe('deepseek-chat')
  // 明文不出现在任何可序列化位置（适配器用 ES 私有字段持有配置）。
  expect(JSON.stringify(adapter)).not.toContain('sk-from-lease')
})

test('fails loudly when the model key is missing from its source', async () => {
  const credentials = new LocalCredentials({ sources: { [MODEL_CREDENTIAL_NAME]: () => undefined } })

  await expect(createModelAdapterFactory({
    credentials,
    settings: {},
    maxAttempts: 1,
  })).rejects.toThrow('credential deepseek is not available from its source')
})

test('a credential value never reaches a spawned command environment', async () => {
  // C3 拒绝测试：凭据"存在"不等于子进程能看见它。
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
