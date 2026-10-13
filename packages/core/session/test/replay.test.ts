import { expect, test } from 'vitest'
import { deriveMessages, deriveRequest, snapKeepFrom } from '../src/replay.ts'
import type { SessionEvent } from '../src/types.ts'

function ev(type: SessionEvent['type'], extra: Record<string, unknown> = {}): SessionEvent {
  return { type, ...extra } as SessionEvent
}

test('projects user and assistant messages, skips boundary and chunk events', () => {
  const events: SessionEvent[] = [
    ev('turn/start', { turnId: 't1' }),
    ev('step/start', { stepId: 's1', turnId: 't1' }),
    ev('user/message', { messageId: 'm1', content: [{ type: 'text', text: '你好' }] }),
    ev('request/header', { stepId: 's1', header: { provider: 'test', model: 'm1' } }),
    ev('assistant/chunk', { stepId: 's1', delta: '你' }),
    ev('assistant/chunk', { stepId: 's1', delta: '好' }),
    ev('assistant/message', { messageId: 'm2', stepId: 's1', content: [{ type: 'text', text: '你好' }] }),
    ev('step/end', { stepId: 's1' }),
    ev('turn/end', { turnId: 't1' }),
  ]

  expect(deriveMessages(events)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
  ])
})

test('the assembly snapshot is not model-visible and never enters the projection', () => {
  const mountEvent: SessionEvent = {
    type: 'session/mount',
    mount: {
      recipe: { id: 'declarative-agent', version: '2.0.0', contractVersion: 1 },
      capabilities: [{ kind: 'llm', provider: 'local-adapter', features: ['tool-calling'] }],
      optionalMissing: [],
      permission: { profile: 'ask', source: 'manifest' },
      config: null,
    },
  }
  const events: SessionEvent[] = [
    mountEvent,
    ev('user/message', { messageId: 'm1', content: [{ type: 'text', text: '你好' }] }),
    ev('step/start', { stepId: 's1', turnId: 't1' }),
    ev('request/header', { stepId: 's1', header: { provider: 'test', model: 'm1' } }),
    ev('assistant/message', { messageId: 'm2', stepId: 's1', content: [{ type: 'text', text: '你好' }] }),
    ev('turn/end', { turnId: 't1' }),
  ]

  expect(deriveMessages(events)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '你好' }] },
  ])
  expect(deriveRequest(events, 's1')?.messages).toEqual([
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
  ])
})

test('logs written before the mount event existed still project identically', () => {
  // 旧日志（无 session/mount）没有格式变更：同一条对话的事件序列不变。
  const events: SessionEvent[] = [
    ev('turn/start', { turnId: 't1' }),
    ev('user/message', { messageId: 'm1', content: [{ type: 'text', text: '旧日志' }] }),
    ev('step/start', { stepId: 's1', turnId: 't1' }),
    ev('request/header', { stepId: 's1', header: { provider: 'test', model: 'm1', systemPrompt: '旧提示' } }),
    ev('assistant/message', { messageId: 'm2', stepId: 's1', content: [{ type: 'text', text: '照旧' }] }),
    ev('turn/end', { turnId: 't1' }),
  ]

  expect(deriveMessages(events)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '旧日志' }] },
    { role: 'assistant', content: [{ type: 'text', text: '照旧' }] },
  ])
  expect(deriveRequest(events, 's1')).toMatchObject({ provider: 'test', model: 'm1', systemPrompt: '旧提示' })
})

test('pairs tool calls with results into tool-result messages', () => {
  const events: SessionEvent[] = [
    ev('user/message', { messageId: 'm1', content: [{ type: 'text', text: '读文件' }] }),
    ev('assistant/message', { messageId: 'm2', stepId: 's1', content: [{ type: 'text', text: '好的' }] }),
    ev('tool/call', { id: 'c1', stepId: 's1', name: 'read_file', args: { path: 'a.ts' } }),
    ev('tool/result', { id: 'c1', ok: true, output: { text: '内容A' } }),
  ]

  expect(deriveMessages(events)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '读文件' }] },
    {
      role: 'assistant',
      content: [{ type: 'text', text: '好的' }],
      toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
    },
    { role: 'tool-result', toolCallId: 'c1', content: '内容A', ok: true },
  ])
})

test('unpaired tool calls and results are not projected', () => {
  const events: SessionEvent[] = [
    ev('tool/call', { id: 'c1', stepId: 's1', name: 'read_file', args: {} }),
    ev('tool/result', { id: 'c2', ok: true, output: { text: '孤立结果' } }),
  ]

  expect(deriveMessages(events)).toEqual([])
})

test('an interrupted assistant message still projects as an assistant message', () => {
  const events: SessionEvent[] = [
    ev('assistant/message', {
      messageId: 'm1',
      stepId: 's1',
      content: [{ type: 'text', text: '说到一半就被' }],
      thinking: '还没想完',
      interrupted: true,
    }),
  ]

  expect(deriveMessages(events)).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'text', text: '说到一半就被' }],
      thinking: '还没想完',
    },
  ])
})

test('reconstructs each request from its header and only the preceding log prefix', () => {
  const tools = [{
    name: 'echo',
    description: 'Echo arguments.',
    parameters: { type: 'object' },
  }]
  const events: SessionEvent[] = [
    ev('user/message', { messageId: 'u1', content: [{ type: 'text', text: '开始' }] }),
    ev('step/start', { stepId: 's1', turnId: 't1' }),
    ev('request/header', {
      stepId: 's1',
      header: { provider: 'deepseek', model: 'deepseek-chat', systemPrompt: 'be precise', tools },
    }),
    ev('assistant/message', {
      messageId: 'a1',
      stepId: 's1',
      content: [],
      thinking: '需要工具',
    }),
    ev('tool/call', { id: 'c1', stepId: 's1', name: 'echo', args: { text: 'x' } }),
    ev('tool/result', { id: 'c1', ok: true, output: { text: 'x' } }),
    ev('step/end', { stepId: 's1' }),
    ev('step/start', { stepId: 's2', turnId: 't1' }),
    ev('request/header', {
      stepId: 's2',
      header: { provider: 'deepseek', model: 'deepseek-chat', systemPrompt: 'be precise', tools },
    }),
    ev('assistant/message', {
      messageId: 'a2',
      stepId: 's2',
      content: [{ type: 'text', text: '未来回复' }],
    }),
  ]

  expect(deriveRequest(events, 's1')).toEqual({
    provider: 'deepseek',
    model: 'deepseek-chat',
    systemPrompt: 'be precise',
    tools,
    messages: [{ role: 'user', content: [{ type: 'text', text: '开始' }] }],
  })
  expect(deriveRequest(events, 's2')).toEqual({
    provider: 'deepseek',
    model: 'deepseek-chat',
    systemPrompt: 'be precise',
    tools,
    messages: [
      { role: 'user', content: [{ type: 'text', text: '开始' }] },
      {
        role: 'assistant',
        content: [],
        thinking: '需要工具',
        toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'x' } }],
      },
      { role: 'tool-result', toolCallId: 'c1', content: 'x', ok: true },
    ],
  })
  expect(deriveRequest(events, 'missing')).toBeUndefined()
})

/** 一段带工具调用的历史：user -> assistant(tool_call) -> tool_result。 */
function toolTurn(turnId: string, stepId: string, callId: string, text: string): SessionEvent[] {
  return [
    ev('turn/start', { turnId }),
    ev('step/start', { stepId, turnId }),
    ev('user/message', { messageId: turnId + '-u', content: [{ type: 'text', text }] }),
    ev('request/header', { stepId, header: { provider: 'test', model: 'm1' } }),
    ev('assistant/message', { messageId: turnId + '-a', stepId, content: [{ type: 'text', text: '调用工具' }] }),
    ev('tool/call', { id: callId, stepId, name: 'read_file', args: { path: 'a.txt' } }),
    ev('tool/result', { id: callId, ok: true, output: { text: '文件内容' } }),
    ev('step/end', { stepId }),
    ev('turn/end', { turnId }),
  ]
}

function compaction(keepFrom: number, summary: string): SessionEvent {
  return ev('context/compacted', {
    summary,
    keepFrom,
    reason: 'threshold',
    input: { from: 0, to: keepFrom, template: 'compact-v1' },
    before: 100_000,
    after: 4_000,
  })
}

test('a compaction event replaces the prefix with its summary and keeps the tail verbatim', () => {
  const first = toolTurn('t1', 's1', 'c1', '第一轮')
  const second = toolTurn('t2', 's2', 'c2', '第二轮')
  const events: SessionEvent[] = [...first, ...second, compaction(first.length, '（早前对话的摘要）')]

  expect(deriveMessages(events)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '（早前对话的摘要）' }] },
    { role: 'user', content: [{ type: 'text', text: '第二轮' }] },
    { role: 'assistant', content: [{ type: 'text', text: '调用工具' }], toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'a.txt' } }] },
    { role: 'tool-result', toolCallId: 'c2', content: '文件内容', ok: true },
  ])
})

test('everything appended after a compaction is projected on top of the summary', () => {
  const first = toolTurn('t1', 's1', 'c1', '第一轮')
  const events: SessionEvent[] = [
    ...first,
    compaction(first.length, '摘要'),
    ev('turn/start', { turnId: 't2' }),
    ev('user/message', { messageId: 'm-later', content: [{ type: 'text', text: '之后的问题' }] }),
    ev('request/header', { stepId: 's3', header: { provider: 'test', model: 'm1' } }),
  ]

  expect(deriveMessages(events)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '摘要' }] },
    { role: 'user', content: [{ type: 'text', text: '之后的问题' }] },
  ])
  // 压缩之后重建的请求也含摘要（请求是投影的结果，不是重放）
  expect(deriveRequest(events, 's3')?.messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '摘要' }] })
})

test('with several compactions the last one wins, and older ones inside the tail stay invisible', () => {
  const first = toolTurn('t1', 's1', 'c1', '第一轮')
  const second = toolTurn('t2', 's2', 'c2', '第二轮')
  const events: SessionEvent[] = [
    ...first,
    ...second,
    compaction(second.length, '旧摘要'),
    ev('user/message', { messageId: 'm-3', content: [{ type: 'text', text: '第三轮' }] }),
    // 新边界落在"旧摘要"**之前**：旧压缩事件因此落在保留区里，不应再次生效
    compaction(first.length + second.length, '新摘要'),
  ]

  expect(deriveMessages(events)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '新摘要' }] },
    { role: 'user', content: [{ type: 'text', text: '第三轮' }] },
  ])
})

test('snapKeepFrom moves the boundary back so a tool pair is never cut in half', () => {
  const turn = toolTurn('t1', 's1', 'c1', '第一轮')
  const resultIndex = turn.findIndex(event => event.type === 'tool/result')
  const callIndex = turn.findIndex(event => event.type === 'tool/call')

  expect(snapKeepFrom(turn, resultIndex)).toBe(callIndex)
  expect(snapKeepFrom(turn, 0)).toBe(0)
  expect(snapKeepFrom(turn, turn.length)).toBe(turn.length)
  expect(snapKeepFrom(turn, -5)).toBe(0)
  // 找不到配对的孤立 result：不吸附（投影会把它丢掉，见下一条测试）
  const orphan: SessionEvent[] = [ev('tool/result', { id: 'ghost', ok: true, output: { text: 'x' } })]
  expect(snapKeepFrom(orphan, 0)).toBe(0)
})

test('a boundary that cuts a pair anyway still yields a valid projection', () => {
  const turn = toolTurn('t1', 's1', 'c1', '第一轮')
  const resultIndex = turn.findIndex(event => event.type === 'tool/result')
  // 生产者忘了吸附：投影必须自己防御 —— 孤立的 tool-result 被丢掉，请求仍然合法
  const events: SessionEvent[] = [...turn, compaction(resultIndex, '摘要')]

  expect(deriveMessages(events)).toEqual([
    { role: 'user', content: [{ type: 'text', text: '摘要' }] },
  ])
})
