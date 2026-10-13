import { expect, test } from 'vitest'
import { join } from 'node:path'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import {
  loadInstructionTiers,
  PROJECT_INSTRUCTION_ORDER,
  renderInstructionTier,
  USER_INSTRUCTION_ORDER,
  withInstructions,
} from '../src/index.ts'
import type { InstructionTier } from '../src/index.ts'
import type { AgentRecipe } from '@cubus/agent-recipe'

/** 测试用的最小 recipe：只关心"装配参数怎么进系统提示"，所以 mount 是空的。 */
function fakeRecipe(): AgentRecipe<object> {
  return {
    manifest: {
      contractVersion: 1, id: 'demo', version: '1.0.0', displayName: 'Demo', requires: [],
      prompt: { fragmentId: 'demo.role' }, tools: [], permission: { profile: 'ask' },
    },
    mount() {},
  }
}

/** 假文件系统：只有给定的路径存在。 */
function reader(files: Record<string, string>, onRead?: (path: string) => void) {
  return async (path: string): Promise<string> => {
    onRead?.(path)
    const text = files[path]
    if (text === undefined) throw new Error('ENOENT: no such file or directory, open ' + path)
    return text
  }
}

const WORKSPACE = '/repo'

test('nothing configured means no tiers and no noise', async () => {
  const loaded = await loadInstructionTiers({ readText: reader({}), workspaceDir: WORKSPACE })
  expect(loaded.tiers).toEqual([])
  expect(loaded.notices).toEqual([])
})

test('AGENTS.md wins over CLAUDE.md, and a user layer is loaded first', async () => {
  const loaded = await loadInstructionTiers({
    readText: reader({
      [join(WORKSPACE, 'AGENTS.md')]: '构建用 pnpm run check。',
      [join(WORKSPACE, 'CLAUDE.md')]: '这份不该被读到。',
      '/home/me/.cubus/instructions.md': '回答尽量用中文。',
    }),
    workspaceDir: WORKSPACE,
    userPath: '/home/me/.cubus/instructions.md',
  })

  expect(loaded.tiers.map(tier => tier.source)).toEqual(['user', 'project'])
  expect(loaded.tiers[0]?.text).toBe('回答尽量用中文。')
  expect(loaded.tiers[1]?.text).toBe('构建用 pnpm run check。')
  expect(loaded.tiers[0]?.path).toBe('/home/me/.cubus/instructions.md')
  expect(loaded.tiers[1]?.path).toBe('AGENTS.md')
  expect(loaded.notices).toEqual([])
})

test('CLAUDE.md is used when AGENTS.md is absent', async () => {
  const loaded = await loadInstructionTiers({
    readText: reader({ [join(WORKSPACE, 'CLAUDE.md')]: '用 vitest。' }),
    workspaceDir: WORKSPACE,
  })
  expect(loaded.tiers.map(tier => tier.path)).toEqual(['CLAUDE.md'])
})

test('an over-long tier is truncated loudly, and the hash covers the original', async () => {
  const long = 'x'.repeat(100)
  const loaded = await loadInstructionTiers({
    readText: reader({ [join(WORKSPACE, 'AGENTS.md')]: long }),
    workspaceDir: WORKSPACE,
    limits: { perTier: 40, total: 1_000 },
  })

  const tier = loaded.tiers[0]
  expect(tier?.text).toHaveLength(40)
  expect(tier?.chars).toBe(40)
  expect(tier?.truncated).toBe(true)
  // 哈希算的是**原文**：这样能判断"文件是不是同一份"，即使当时被截断过
  expect(tier?.sha256).toBe((await import('node:crypto')).createHash('sha256').update(long).digest('hex'))
  expect(loaded.notices.join(' ')).toContain('已截断')
})

test('the total budget is shared: the second tier gets what is left', async () => {
  const loaded = await loadInstructionTiers({
    readText: reader({
      [join(WORKSPACE, 'AGENTS.md')]: 'a'.repeat(50),
      '/user.md': 'b'.repeat(50),
    }),
    workspaceDir: WORKSPACE,
    userPath: '/user.md',
    limits: { perTier: 100, total: 60 },
  })

  expect(loaded.tiers[0]?.text).toHaveLength(50)
  expect(loaded.tiers[1]?.text).toHaveLength(10)
  expect(loaded.tiers[1]?.truncated).toBe(true)
})

test('a read failure that is not "missing" is reported, not swallowed', async () => {
  const loaded = await loadInstructionTiers({
    readText: async path => {
      if (path.endsWith('AGENTS.md')) throw new Error('EACCES: permission denied')
      throw new Error('ENOENT: no such file or directory')
    },
    workspaceDir: WORKSPACE,
  })
  expect(loaded.tiers).toEqual([])
  expect(loaded.notices.join(' ')).toContain('EACCES')
})

test('the rendered project tier states its precedence over the generic text', () => {
  const tier: InstructionTier = { source: 'project', path: 'AGENTS.md', chars: 3, sha256: 'x', truncated: false, text: '约定' }
  const rendered = renderInstructionTier(tier)
  expect(rendered).toContain('项目约定')
  expect(rendered).toContain('优先于')
  expect(rendered).toContain('约定')
})

test('withInstructions registers one fragment per tier, in precedence order', async () => {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  const decorated = withInstructions(fakeRecipe())

  await decorated.mount(ctx, {
    instructions: [
      { source: 'user', path: '/user.md', chars: 1, sha256: 'a', truncated: false, text: '用户偏好' },
      { source: 'project', path: 'AGENTS.md', chars: 1, sha256: 'b', truncated: false, text: '项目约定' },
    ],
  })

  const fragments = ctx.systemPrompt.list()
  expect(fragments.map(fragment => fragment.id)).toEqual(['instructions.user', 'instructions.project'])
  expect(fragments.map(fragment => fragment.order)).toEqual([USER_INSTRUCTION_ORDER, PROJECT_INSTRUCTION_ORDER])
  const assembled = ctx.systemPrompt.assemble() ?? ''
  expect(assembled.indexOf('用户偏好')).toBeLessThan(assembled.indexOf('项目约定'))
})

test('withInstructions is transparent when the app passes nothing', async () => {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  const decorated = withInstructions(fakeRecipe())
  await decorated.mount(ctx, {})
  expect(ctx.systemPrompt.list()).toEqual([])
})