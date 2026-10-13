import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import type { SessionEvent, SessionLog, SessionLogListener, SessionLogReadResult } from '@cubus/session'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import {
  createReadSessionLogTool,
  READ_SESSION_LOG_TOOL,
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_OUTPUT_PAGE_CHARS,
  withSessionLogTools,
} from '../src/index.ts'

class FakeLog implements SessionLog {
  readonly events: SessionEvent[]
  constructor(events: SessionEvent[]) {
    this.events = events
  }
  async append(event: SessionEvent): Promise<void> {
    this.events.push(event)
  }
  async read(): Promise<SessionLogReadResult> {
    return { events: [...this.events], truncated: false }
  }
  subscribe(_listener: SessionLogListener): () => void {
    return () => undefined
  }
}

/** 一条被截断过的工具结果：两页 + 一小段尾巴。 */
const bigText = 'A'.repeat(TOOL_OUTPUT_PAGE_CHARS) + 'B'.repeat(TOOL_OUTPUT_PAGE_CHARS) + 'C'.repeat(500)

function makeLog(): FakeLog {
  return new FakeLog([
    { type: 'user/message', messageId: 'm1', content: [{ type: 'text', text: '读一下大文件' }] },
    { type: 'step/start', stepId: 's1', turnId: 't1' },
    { type: 'request/header', stepId: 's1', header: { provider: 'test', model: 'm1' } },
    { type: 'assistant/message', messageId: 'm2', stepId: 's1', content: [{ type: 'text', text: '读文件' }] },
    { type: 'tool/call', id: 'c1', stepId: 's1', name: 'read_file', args: { path: 'big.txt' } },
    { type: 'tool/result', id: 'c1', ok: true, output: { text: bigText } },
    { type: 'step/end', stepId: 's1' },
  ])
}

const signal = new AbortController().signal

test('the decorator declares the tool and registers it with session-log access', async () => {
  const log = makeLog()
  const decorated = withSessionLogTools({
    manifest: {
      contractVersion: 1, id: 'demo', version: '1.0.0', displayName: 'Demo', requires: [],
      prompt: { fragmentId: 'demo' }, tools: [], permission: { profile: 'ask' },
    },
    mount() {},
  })
  // 声明面被补上工具名（否则装配期校验会拦下它）
  expect(decorated.manifest.tools).toEqual([READ_SESSION_LOG_TOOL])

  const ctx = new Context()
  await ctx.plugin(toolRegistryPlugin)
  ctx.provide('sessionLog', log)
  await decorated.mount(ctx, undefined)
  expect(ctx.tools.snapshot().map(tool => tool.name)).toEqual([READ_SESSION_LOG_TOOL])
})

test('tool_output pages through the full text that the projection truncated', async () => {
  const tool = createReadSessionLogTool(makeLog())

  const first = await tool.execute({ kind: 'tool_output', id: 'c1' }, { signal })
  expect(first).toContain('共 ' + String(bigText.length) + ' 字符')
  expect(first).toContain('本次返回 [0, ' + String(TOOL_OUTPUT_PAGE_CHARS) + ')')
  expect(first).toContain('继续')
  expect(first).toContain('A'.repeat(50))

  const second = await tool.execute({ kind: 'tool_output', id: 'c1', offset: TOOL_OUTPUT_PAGE_CHARS }, { signal })
  expect(second).toContain('B'.repeat(50))

  const third = await tool.execute({ kind: 'tool_output', id: 'c1', offset: TOOL_OUTPUT_PAGE_CHARS * 2 }, { signal })
  expect(third).toContain('（已到结尾）')
  expect(third).toContain('C'.repeat(100))

  // 单次返回有上限：传超大 limit 会被夹到常量（否则这个工具自己就能撑爆窗口）
  const capped = await tool.execute({ kind: 'tool_output', id: 'c1', limit: 999_999 }, { signal })
  expect(capped).toContain('本次返回 [0, ' + String(TOOL_OUTPUT_MAX_CHARS) + ')')
})

test('messages lists raw entries of a log range and unknown ids fail loudly', async () => {
  const tool = createReadSessionLogTool(makeLog())

  const listed = await tool.execute({ kind: 'messages', from: 0, to: 6 }, { signal })
  expect(listed).toContain('[#0] user: 读一下大文件')
  expect(listed).toContain('[#3] assistant: 读文件')
  expect(listed).toContain('[#5] tool/result(c1):')
  // 每条都有预览上限：整段读数远小于原文
  expect(String(listed).length).toBeLessThan(bigText.length)

  await expect(tool.execute({ kind: 'tool_output', id: 'nope' }, { signal }))
    .rejects.toThrow('no tool result with id nope')
  await expect(tool.execute({ kind: 'nope' }, { signal }))
    .rejects.toThrow('kind must be "tool_output" or "messages"')
  await expect(tool.execute({ kind: 'tool_output' }, { signal }))
    .rejects.toThrow('missing argument: id')
})

test('the tool describes both read-back modes so the model can use it unprompted', () => {
  const tool = createReadSessionLogTool(makeLog())
  expect(tool.description).toContain('tool_output')
  expect(tool.description).toContain('messages')
  expect(JSON.stringify(tool.parameters)).toContain('"offset"')
})
