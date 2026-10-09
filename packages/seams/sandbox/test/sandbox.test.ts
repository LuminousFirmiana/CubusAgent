import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { SANDBOX_FEATURES, satisfiesSandboxFeatures, UnconfinedSandbox } from '../src/index.ts'

test('the local provider honestly declares that it has no isolation', () => {
  const sandbox = new UnconfinedSandbox()

  expect(sandbox.provider).toBe('local-unconfined')
  expect(sandbox.features).toEqual(['unconfined'])
  expect(sandbox.describe()).toContain('no isolation')
  // 每个特性都必须在闭集里 —— 拼错的特性名会让协商静默失效。
  for (const feature of sandbox.features) {
    expect(SANDBOX_FEATURES).toContain(feature)
  }
})

test('unconfined never satisfies a requirement for real isolation', () => {
  const { features } = new UnconfinedSandbox()

  expect(satisfiesSandboxFeatures(features, [])).toBe(true)
  expect(satisfiesSandboxFeatures(features, ['unconfined'])).toBe(true)
  expect(satisfiesSandboxFeatures(features, ['fs-isolation'])).toBe(false)
  expect(satisfiesSandboxFeatures(features, ['unconfined', 'fs-isolation'])).toBe(false)
})

test('the sandbox service is provided under a typed key and rolls back with the fiber', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin({
    name: 'sandbox-holder',
    apply(holder: Context) {
      holder.provide('sandbox', new UnconfinedSandbox())
    },
  })
  await fiber

  expect(ctx.sandbox.provider).toBe('local-unconfined')

  await fiber.dispose()
  expect(ctx.get('sandbox')).toBeUndefined()
})
