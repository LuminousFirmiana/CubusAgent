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

test('a tool may carry a dynamic source: snapshots expose it, empty sources are rejected', () => {
  const registry = new ToolRegistryService()
  registry.register(tool('builtin'))
  registry.register(tool('remote'), { source: 'mcp' })

  const snapshot = registry.snapshot()
  expect(snapshot.map(item => item.name)).toEqual(['builtin', 'remote'])
  // 内建工具没有来源字段；动态工具多一个 source —— 它只用于装配期校验，不进工具定义。
  expect(snapshot[0]?.source).toBeUndefined()
  expect(snapshot[1]?.source).toBe('mcp')
  expect(Object.keys(snapshot[1] ?? {}).sort()).toEqual(['description', 'execute', 'name', 'parameters', 'source'])

  expect(() => registry.register(tool('bad'), { source: '  ' })).toThrow('source must not be empty')
  expect(registry.snapshot().map(item => item.name)).toEqual(['builtin', 'remote'])
})

test('toolContribution forwards the source option and keeps the lifecycle reversible', async () => {
  const ctx = new Context()
  await ctx.plugin(toolRegistryPlugin)
  const contribution = ctx.plugin(toolContribution(tool('remote'), { source: 'mcp' }))
  await contribution

  expect(ctx.tools.snapshot().map(item => item.source)).toEqual(['mcp'])
  await contribution.dispose()
  expect(ctx.tools.snapshot()).toEqual([])
})
