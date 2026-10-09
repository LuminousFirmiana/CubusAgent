import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { CredentialsError, LocalCredentials } from '../src/index.ts'

const reference = { name: 'deepseek', kind: 'env' } as const

test('issues a lease for an allowlisted name and reveals the value only through it', async () => {
  const credentials = new LocalCredentials({
    sources: { deepseek: () => 'sk-test-value' },
  })

  expect(credentials.provider).toBe('local-env')
  expect(credentials.names).toEqual(['deepseek'])

  const lease = await credentials.issue(reference)
  expect(lease.reference).toEqual(reference)
  expect(lease.reveal()).toBe('sk-test-value')
  await lease.release()
  // release 之后本地实现不销毁已取出的值（调用方自己的责任），但租约仍可再次取出。
  expect(lease.reveal()).toBe('sk-test-value')
})

test('a reference carries no plaintext even when serialized', async () => {
  const credentials = new LocalCredentials({ sources: { deepseek: () => 'sk-test-value' } })
  const lease = await credentials.issue(reference)

  expect(JSON.stringify(lease.reference)).toBe('{"name":"deepseek","kind":"env"}')
  expect(JSON.stringify(credentials.names)).not.toContain('sk-test-value')
})

test('rejects names outside the allowlist and names whose source is empty', async () => {
  const credentials = new LocalCredentials({
    sources: {
      deepseek: () => 'sk-test-value',
      empty: () => undefined,
    },
  })

  await expect(credentials.issue({ name: 'github', kind: 'env' })).rejects.toThrow(CredentialsError)
  await expect(credentials.issue({ name: 'github', kind: 'env' })).rejects.toThrow(
    'credential not in the local allowlist: github (available: deepseek, empty)',
  )
  await expect(credentials.issue({ name: 'empty', kind: 'env' })).rejects.toThrow(
    'credential empty is not available from its source',
  )
})

test('the credentials service is provided under a typed key and rolls back with the fiber', async () => {
  const ctx = new Context()
  const credentials = new LocalCredentials({ sources: { deepseek: () => 'sk-test-value' } })
  const fiber = ctx.plugin({
    name: 'credentials-holder',
    apply(holder: Context) {
      holder.provide('credentials', credentials)
    },
  })
  await fiber

  expect(ctx.credentials.provider).toBe('local-env')

  await fiber.dispose()
  expect(ctx.get('credentials')).toBeUndefined()
})
