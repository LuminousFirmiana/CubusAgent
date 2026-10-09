import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { isWithin, parseWorkbenchCommand, WORKBENCH_COMMAND_HELP } from '../src/main.ts'

test('the workbench requires an explicit workspace and approval level', () => {
  expect(parseWorkbenchCommand(['--help']).help).toBe(true)
  // pnpm run 会把 -- 原样传进来（仓库里记过的坑），要容忍
  expect(parseWorkbenchCommand(['--', '--workspace', '/tmp/x', '--approval', 'allow']).options)
    .toMatchObject({ workspace: '/tmp/x', approval: 'allow' })
  expect(() => parseWorkbenchCommand([])).toThrow('workbench requires --workspace <path>')
  expect(() => parseWorkbenchCommand(['--workspace', '/tmp/x']))
    .toThrow('workbench requires an explicit --approval allow|deny')
  expect(() => parseWorkbenchCommand(['--workspace', '/tmp/x', '--approval', 'maybe']))
    .toThrow('--approval must be allow or deny')
  expect(() => parseWorkbenchCommand(['--workspace', '/tmp/x', '--approval', 'allow', '--nope']))
    .toThrow('unknown option: --nope')
  expect(() => parseWorkbenchCommand(['--workspace'])).toThrow('--workspace requires a value')
  expect(() => parseWorkbenchCommand(['--workspace', '/tmp/x', '--approval', 'allow', '--port', '-1']))
    .toThrow('--port must be a non-negative integer')

  const parsed = parseWorkbenchCommand(['--workspace', '/tmp/x', '--approval', 'deny', '--port', '4180', '--max-attempts', '5'])
  expect(parsed.options).toMatchObject({ workspace: '/tmp/x', approval: 'deny', port: 4180, maxAttempts: 5 })
  // 默认会话目录在临时目录里（工作区之外）
  expect(parsed.options?.sessionsDir.startsWith(tmpdir())).toBe(true)
  expect(WORKBENCH_COMMAND_HELP).toContain('--approval allow|deny')
})

test('isWithin decides whether a sessions directory sits inside the tool-writable workspace', () => {
  expect(isWithin('/tmp/ws', '/tmp/ws/sessions')).toBe(true)
  expect(isWithin('/tmp/ws', '/tmp/ws')).toBe(true)
  expect(isWithin('/tmp/ws', '/tmp/elsewhere')).toBe(false)
  // 前缀相同但不同目录：不能靠字符串前缀判断
  expect(isWithin('/tmp/ws', '/tmp/ws-other')).toBe(false)
  expect(isWithin('/tmp/ws', join('/tmp', 'ws', '..', 'ws-other'))).toBe(false)
})
