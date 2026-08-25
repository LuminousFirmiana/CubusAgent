import { expect, test } from 'vitest'
import { deriveMessages, deriveRequest } from '../src/replay.ts'
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
