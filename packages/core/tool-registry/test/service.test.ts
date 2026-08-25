import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import {
  ToolRegistryService,
  toolContribution,
  toolRegistryPlugin,
} from '../src/index.ts'
import type { Tool } from '../src/index.ts'

function tool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    parameters: { type: 'object' },
    execute: () => name,
  }
}

test('returns immutable snapshots in deterministic name order', () => {
  const registry = new ToolRegistryService()
  registry.register(tool('zeta'))
  registry.register(tool('alpha'))

  const snapshot = registry.snapshot()
  expect(snapshot.map(item => item.name)).toEqual(['alpha', 'zeta'])
  expect(Object.isFrozen(snapshot)).toBe(true)
})

test('rejects duplicate and malformed tools without changing the registry', () => {
  const registry = new ToolRegistryService()
  registry.register(tool('known'))

  expect(() => registry.register(tool('known'))).toThrow('tool already registered: known')
  expect(() => registry.register({ ...tool(''), description: 'x' })).toThrow('name must not be empty')
  expect(() => registry.register({ ...tool('bad'), description: '' })).toThrow('description must not be empty')
  expect(registry.snapshot().map(item => item.name)).toEqual(['known'])
})

test('Cordis owns contribution and provider lifecycles', async () => {
  const ctx = new Context()
  const provider = ctx.plugin(toolRegistryPlugin)
  await provider
  const contribution = ctx.plugin(toolContribution(tool('lookup')))
  await contribution

  expect(ctx.tools.snapshot().map(item => item.name)).toEqual(['lookup'])

  await contribution.dispose()
  expect(ctx.tools.snapshot()).toEqual([])

  await provider.dispose()
  expect(ctx.get('tools')).toBeUndefined()
})
