import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import {
  SystemPromptService,
  systemPromptContribution,
  systemPromptPlugin,
} from '../src/index.ts'

test('assembles fragments by order and id while omitting empty text', () => {
  const service = new SystemPromptService()
  service.register({ id: 'z-last-at-zero', text: 'Z' })
  service.register({ id: 'a-first-at-zero', render: () => 'A' })
  service.register({ id: 'early', order: -10, text: 'EARLY' })
  service.register({ id: 'empty', order: 20, text: '' })

  expect(service.assemble()).toBe('EARLY\n\nA\n\nZ')
  expect(service.list().map(fragment => fragment.id)).toEqual([
    'early',
    'a-first-at-zero',
    'z-last-at-zero',
    'empty',
  ])
})

test('rejects duplicate identities and malformed fragments without changing state', () => {
  const service = new SystemPromptService()
  service.register({ id: 'identity', text: 'first' })

  expect(() => service.register({ id: 'identity', text: 'second' })).toThrow(
    'system prompt fragment already registered: identity',
  )
  expect(() => service.register({ id: '', text: 'x' })).toThrow('id must not be empty')
  expect(() => service.register({ id: 'both', text: 'x', render: () => 'y' })).toThrow(
    'must define exactly one',
  )
  expect(() => service.register({ id: 'bad-order', order: Number.NaN, text: 'x' })).toThrow(
    'order must be finite',
  )
  expect(service.assemble()).toBe('first')
})

test('Cordis owns contribution and provider lifecycles', async () => {
  const ctx = new Context()
  const provider = ctx.plugin(systemPromptPlugin)
  await provider
  const contribution = ctx.plugin(systemPromptContribution({ id: 'role', text: 'Be precise.' }))
  await contribution

  expect(ctx.systemPrompt.assemble()).toBe('Be precise.')

  await contribution.dispose()
  expect(ctx.systemPrompt.assemble()).toBeUndefined()

  await provider.dispose()
  expect(ctx.get('systemPrompt')).toBeUndefined()
})
