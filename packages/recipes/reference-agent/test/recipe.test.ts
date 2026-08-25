import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import {
  REFERENCE_AGENT_PROMPT,
  referenceAgentRecipe,
} from '../src/index.ts'

test('contributes only the domain-neutral prompt and add_numbers tool', async () => {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolRegistryPlugin)
  await referenceAgentRecipe.mount(ctx, undefined)

  expect(ctx.systemPrompt.assemble()).toBe(REFERENCE_AGENT_PROMPT)
  const tools = ctx.tools.snapshot()
  const executionContext = { signal: new AbortController().signal }
  expect(tools.map(tool => tool.name)).toEqual(['add_numbers'])
  expect(await tools[0]!.execute({ a: 2, b: 3 }, executionContext)).toBe('5')
  expect(() => tools[0]!.execute({ a: 2, b: Number.NaN }, executionContext)).toThrow(
    'argument b must be a finite number',
  )
})
