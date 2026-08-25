import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import type { Tool } from '@cubus/tool-registry'
import {
  createStaticToolApproval,
  withToolApproval,
  withToolApprovalHost,
} from '../src/index.ts'

const activeSignal = new AbortController().signal
const executionContext = { signal: activeSignal }

function testTool(execute: Tool['execute']): Tool {
  return {
    name: 'write_value',
    description: 'Write one value.',
    parameters: { type: 'object' },
    execute,
  }
}

test('allow executes the underlying tool exactly once', async () => {
  let calls = 0
  const tool = withToolApproval(testTool(() => {
    calls += 1
    return 'done'
  }), createStaticToolApproval('allow', 'test'))

  await expect(tool.execute({ value: 1 }, executionContext)).resolves.toBe('done')
  expect(calls).toBe(1)
})

test('deny never executes the underlying tool and execution failures preserve approval state', async () => {
  let calls = 0
  const denied = withToolApproval(testTool(() => {
    calls += 1
    return 'must not happen'
  }), createStaticToolApproval('deny', 'not approved'))
  await expect(denied.execute({ value: 1 }, executionContext)).rejects.toThrow(
    'tool denied by approval policy: write_value (not approved)',
  )
  expect(calls).toBe(0)

  const failing = withToolApproval(testTool(() => { throw new Error('disk full') }), createStaticToolApproval('allow'))
  await expect(failing.execute({ value: 1 }, executionContext)).rejects.toThrow(
    'tool approved but execution failed: write_value (disk full)',
  )
})

test('cancellation prevents approval and underlying execution', async () => {
  let decisions = 0
  let executions = 0
  const controller = new AbortController()
  controller.abort(new Error('cancel approval'))
  const tool = withToolApproval(testTool(() => {
    executions += 1
    return 'must not happen'
  }), {
    decide() {
      decisions += 1
      return { outcome: 'allow' }
    },
  })

  await expect(tool.execute({ value: 1 }, { signal: controller.signal })).rejects.toThrow('cancel approval')
  expect(decisions).toBe(0)
  expect(executions).toBe(0)
})

test('Host decoration provides approval with the same reversible lifecycle', async () => {
  const baseHost = {
    mount(ctx: Context) {
      ctx.provide('baseService', 'ready')
    },
  }
  const approval = createStaticToolApproval('allow')
  const host = withToolApprovalHost(baseHost, approval)
  const ctx = new Context()
  const fiber = ctx.plugin({
    name: 'approval-host-test',
    apply(hostContext: Context) {
      return host.mount(hostContext, { id: 's1', directory: '/tmp/s1', logPath: '/tmp/s1/session.jsonl' })
    },
  })
  await fiber

  expect(ctx.get('baseService')).toBe('ready')
  expect(ctx.get('toolApproval')).toBe(approval)

  await fiber.dispose()
  expect(ctx.get('baseService')).toBeUndefined()
  expect(ctx.get('toolApproval')).toBeUndefined()
})
