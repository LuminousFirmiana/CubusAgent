import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { isWithin, parseWorkbenchCommand, resolveWorkbenchOptions, WORKBENCH_COMMAND_HELP } from '../src/main.ts'

test('the command line parses flags into overrides (validation happens after merging)', () => {
  expect(parseWorkbenchCommand(['--help']).help).toBe(true)
  // pnpm run 会把 -- 原样传进来（仓库里记过的坑），要容忍
  expect(parseWorkbenchCommand(['--', '--workspace', '/tmp/x', '--approval', 'allow']).overrides)
    .toMatchObject({ workspace: '/tmp/x', approval: 'allow' })
  expect(() => parseWorkbenchCommand(['--workspace', '/tmp/x', '--approval', 'maybe']))
    .toThrow('--approval must be ask, allow or deny')
  expect(() => parseWorkbenchCommand(['--workspace', '/tmp/x', '--approval', 'ask', '--approval-timeout', '0']))
    .toThrow('--approval-timeout must be a positive integer')
  expect(() => parseWorkbenchCommand(['--workspace', '/tmp/x', '--approval', 'allow', '--nope']))
    .toThrow('unknown option: --nope')
  expect(() => parseWorkbenchCommand(['--workspace'])).toThrow('--workspace requires a value')
  expect(() => parseWorkbenchCommand(['--workspace', '/tmp/x', '--approval', 'allow', '--port', '-1']))
    .toThrow('--port must be a non-negative integer')
  expect(parseWorkbenchCommand(['--init', '--config', '/tmp/c.json', '--force']))
    .toMatchObject({ init: true, force: true, configFlag: '/tmp/c.json' })

  const parsed = parseWorkbenchCommand(['--workspace', '/tmp/x', '--approval', 'deny', '--port', '4180', '--max-attempts', '5'])
  expect(parsed.overrides).toMatchObject({ workspace: '/tmp/x', approval: 'deny', port: 4180, maxAttempts: 5 })
  expect(WORKBENCH_COMMAND_HELP).toContain('--approval ask|allow|deny')
  expect(WORKBENCH_COMMAND_HELP).toContain('--approval-timeout')
})

test('effective options come from the command line, then the config file, then defaults', () => {
  // 什么都没有：报错并指出怎么办
  expect(() => resolveWorkbenchOptions({}, undefined))
    .toThrow('workbench requires a workspace: pass --workspace <path> or set "workspace"')
  expect(() => resolveWorkbenchOptions({ workspace: '/tmp/x' }, undefined))
    .toThrow('workbench requires an explicit approval level')
  // 配置文件提供全部
  const fromConfig = resolveWorkbenchOptions({}, {
    workspace: '/tmp/from-config',
    approval: 'ask',
    approvalTimeoutSeconds: 30,
    port: 4999,
    maxAttempts: 7,
  })
  expect(fromConfig).toEqual({
    workspace: '/tmp/from-config',
    sessionsDir: join(tmpdir(), 'cubus-workbench-sessions'),
    approval: 'ask',
    approvalTimeoutMs: 30_000,
    port: 4999,
    maxAttempts: 7,
  })
  // 命令行覆盖配置文件（逐字段）
  const merged = resolveWorkbenchOptions(
    { approval: 'deny', port: 4180 },
    { workspace: '/tmp/from-config', approval: 'ask', port: 4999, sessionsDir: '/tmp/sessions' },
  )
  expect(merged).toMatchObject({
    workspace: '/tmp/from-config',
    approval: 'deny',
    port: 4180,
    sessionsDir: '/tmp/sessions',
    approvalTimeoutMs: 120_000,
  })
})

test('isWithin decides whether a sessions directory sits inside the tool-writable workspace', () => {
  expect(isWithin('/tmp/ws', '/tmp/ws/sessions')).toBe(true)
  expect(isWithin('/tmp/ws', '/tmp/ws')).toBe(true)
  expect(isWithin('/tmp/ws', '/tmp/elsewhere')).toBe(false)
  // 前缀相同但不同目录：不能靠字符串前缀判断
  expect(isWithin('/tmp/ws', '/tmp/ws-other')).toBe(false)
  expect(isWithin('/tmp/ws', join('/tmp', 'ws', '..', 'ws-other'))).toBe(false)
})
