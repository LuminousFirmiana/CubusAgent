import { expect, test } from 'vitest'
import {
  createRulesToolApproval,
  loadPermissionRules,
  createStaticToolApproval,
  matchesArgs,
  matchesToolName,
  matchPermissionRule,
  parsePermissionRules,
  permissionRulesFingerprint,
} from '../src/index.ts'

const context = { signal: new AbortController().signal } as never

test('the rules file is parsed strictly: typos fail loudly instead of silently degrading', () => {
  const ok = parsePermissionRules({ version: 1, rules: [
    { tool: 'bash', decision: 'ask', args: { contains: ['pnpm run check'] }, reason: '本地检查' },
    { tool: 'read_*', decision: 'allow' },
  ] }, 'p.json')
  expect(ok.rules).toHaveLength(2)
  expect(ok.rules[0]?.args?.contains).toEqual(['pnpm run check'])

  // 权限配置最不该"猜"：把 deny 拼错却静默降级，会让人以为禁掉了其实没有
  expect(() => parsePermissionRules({ rules: [{ tool: 'bash', decision: 'denny' }] }, 'p.json')).toThrow('must be allow, deny or ask')
  expect(() => parsePermissionRules({ rules: [{ decision: 'allow' }] }, 'p.json')).toThrow('.tool must be a non-empty string')
  expect(() => parsePermissionRules({ rules: [{ tool: 'bash', decision: 'allow', args: { regex: '(' } }] }, 'p.json')).toThrow('not a valid regex')
  expect(() => parsePermissionRules({ rules: 'nope' }, 'p.json')).toThrow('"rules" must be an array')
  expect(() => parsePermissionRules({ version: 2, rules: [] }, 'p.json')).toThrow('unsupported version')
})

test('tool name matching is anchored, with * and ? wildcards', () => {
  expect(matchesToolName('bash', 'bash')).toBe(true)
  expect(matchesToolName('bash', 'bashful')).toBe(false)
  expect(matchesToolName('*', 'anything')).toBe(true)
  expect(matchesToolName('read_*', 'read_file')).toBe(true)
  expect(matchesToolName('read_*', 'write_file')).toBe(false)
  expect(matchesToolName('write_?ile', 'write_file')).toBe(true)
  // 正则元字符按字面处理（工具名里出现 . 时不能当通配）
  expect(matchesToolName('a.b', 'axb')).toBe(false)
  expect(matchesToolName('a.b', 'a.b')).toBe(true)
})

test('argument matching reads the JSON form of the call', () => {
  const rule = { tool: 'bash', decision: 'allow' as const, args: { contains: ['pnpm run check'], regex: 'check' } }
  expect(matchesArgs(rule, { command: 'pnpm run check' })).toBe(true)
  expect(matchesArgs(rule, { command: 'pnpm run check --watch' })).toBe(true)
  expect(matchesArgs(rule, { command: 'rm -rf /' })).toBe(false)
  expect(matchesArgs({ tool: 'bash', decision: 'allow' }, { anything: true })).toBe(true)
})

test('the first matching rule wins, in file order', () => {
  const { rules } = parsePermissionRules({ rules: [
    { tool: 'bash', decision: 'deny', reason: 'bash 一律先拦' },
    { tool: 'bash', decision: 'allow' },
  ] }, 'p.json')

  const match = matchPermissionRule(rules, { toolName: 'bash', args: { command: 'ls' } })
  expect(match?.index).toBe(0)
  expect(match?.rule.decision).toBe('deny')
  expect(matchPermissionRule(rules, { toolName: 'read_file', args: {} })).toBeUndefined()
})

test('rules give allow/deny without asking, and hand ask back to the profile', async () => {
  const { rules } = parsePermissionRules({ rules: [
    { tool: 'read_file', decision: 'allow', reason: '读文件不需要问' },
    { tool: 'bash', decision: 'deny', reason: '这个仓库禁止直接跑 shell' },
    { tool: 'write_file', decision: 'ask' },
  ] }, 'p.json')
  let asked = 0
  const fallback = {
    decide: () => { asked += 1; return { outcome: 'allow' as const, reason: 'profile' } },
  }
  const approval = createRulesToolApproval({ rules, fallback })

  expect(await approval.decide({ toolName: 'read_file', args: { path: 'a' } }, context))
    .toEqual({ outcome: 'allow', reason: '读文件不需要问' })
  expect(await approval.decide({ toolName: 'bash', args: { command: 'ls' } }, context))
    .toEqual({ outcome: 'deny', reason: '这个仓库禁止直接跑 shell' })
  // 规则写 ask、以及完全没有规则命中：都交给兜底档位（那里才有 prompter）
  expect(await approval.decide({ toolName: 'write_file', args: {} }, context)).toMatchObject({ outcome: 'allow' })
  expect(await approval.decide({ toolName: 'unknown_tool', args: {} }, context)).toMatchObject({ outcome: 'allow' })
  expect(asked).toBe(2)
})

test('without rules the fallback decides everything (the profile stays the default)', async () => {
  const approval = createRulesToolApproval({ rules: [], fallback: createStaticToolApproval('deny', '无人值守') })
  expect(await approval.decide({ toolName: 'bash', args: {} }, context)).toEqual({ outcome: 'deny', reason: '无人值守' })
})

test('the fingerprint identifies which rules were in force', () => {
  const a = parsePermissionRules({ rules: [{ tool: 'bash', decision: 'deny' }] }, 'p.json')
  const b = parsePermissionRules({ rules: [{ tool: 'bash', decision: 'deny' }] }, 'p.json')
  const c = parsePermissionRules({ rules: [{ tool: 'bash', decision: 'allow' }] }, 'p.json')
  expect(permissionRulesFingerprint(a)).toBe(permissionRulesFingerprint(b))
  expect(permissionRulesFingerprint(a)).not.toBe(permissionRulesFingerprint(c))
})

test('the loader treats "no file" as no rules but refuses to silently degrade a broken file', async () => {
  const missing = await loadPermissionRules({
    path: '/repo/.cubus/permissions.json',
    readText: async () => { throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }) },
  })
  expect(missing.missing).toBe(true)
  expect(missing.file.rules).toEqual([])

  const present = await loadPermissionRules({
    path: '/repo/.cubus/permissions.json',
    readText: async () => JSON.stringify({ version: 1, rules: [{ tool: 'bash', decision: 'deny', reason: '禁止 shell' }] }),
  })
  expect(present.missing).toBe(false)
  expect(present.file.rules).toHaveLength(1)
  expect(present.sha256).toHaveLength(64)

  // 配置了但写坏：抛错（绝不静默降级成"没有规则，那就放行吧"）
  await expect(loadPermissionRules({
    path: '/repo/.cubus/permissions.json',
    readText: async () => '{ 这不是 JSON',
  })).rejects.toThrow()
  await expect(loadPermissionRules({
    path: '/repo/.cubus/permissions.json',
    readText: async () => JSON.stringify({ rules: [{ tool: 'bash', decision: 'denny' }] }),
  })).rejects.toThrow('must be allow, deny or ask')
})
