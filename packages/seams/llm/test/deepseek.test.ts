import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { DeepSeekAdapter } from '../src/deepseek.ts'
import { LlmError } from '../src/errors.ts'
import type { Transport } from '../src/deepseek.ts'
import type { LlmRequest } from '../src/types.ts'

const fixturePath = join(import.meta.dirname, 'fixtures', 'deepseek-stream.txt')

/** 把 fixture 文本包装成 Response（transport 替身：无 key、无网络）。 */
function fixtureTransport(status = 200): Transport {
  let body: string
  return async () => {
    body ??= await readFile(fixturePath, 'utf8')
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } })
  }
}

function makeAdapter(transport: Transport): DeepSeekAdapter {
  return new DeepSeekAdapter({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    transport,
  })
}

async function collect(adapter: DeepSeekAdapter, request: LlmRequest, signal?: AbortSignal) {
  const chunks = []
  for await (const chunk of adapter.stream(request, signal ?? new AbortController().signal)) {
    chunks.push(chunk)
  }
  return chunks
}

const emptyRequest: LlmRequest = {
  provider: 'deepseek',
  model: 'deepseek-chat',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
}

test('parses content deltas and thinking deltas from the recorded SSE stream', async () => {
  const adapter = makeAdapter(fixtureTransport())
  const chunks = await collect(adapter, emptyRequest)

  expect(chunks).toEqual([
    { thinkingDelta: '让我想想。' },
    { delta: '你好' },
    { delta: '！' },
    {
      toolCalls: [{ id: 'call_abc', name: 'echo', args: { x: 1 } }],
    },
  ])
})

test('assembles fragmented tool call arguments into parsed args', async () => {
  const adapter = makeAdapter(fixtureTransport())
  const chunks = await collect(adapter, emptyRequest)

  const toolCallChunk = chunks.at(-1)
  expect(toolCallChunk?.toolCalls).toEqual([{ id: 'call_abc', name: 'echo', args: { x: 1 } }])
})

test('converts projected messages into OpenAI wire format', async () => {
  const captured: { url: string; init: RequestInit }[] = []
  const transport: Transport = async (url, init) => {
    captured.push({ url, init })
    return new Response('data: [DONE]\n\n', { status: 200 })
  }
  const adapter = makeAdapter(transport)

  const request: LlmRequest = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    systemPrompt: '你是一个修 bug 的 agent。',
    tools: [
      {
        name: 'read_file',
        description: 'Read a text file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '读文件' }] },
      {
        role: 'assistant',
        content: [],
        thinking: '先读取文件。',
        toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
      },
      { role: 'tool-result', toolCallId: 'c1', content: '内容A', ok: true },
    ],
  }
  await collect(adapter, request)

  expect(captured).toHaveLength(1)
  expect(captured[0]?.url).toBe('https://api.deepseek.com/chat/completions')
  const sent = JSON.parse(String(captured[0]?.init.body))
  expect(sent.model).toBe('deepseek-chat')
  expect(sent.tools).toEqual([
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a text file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    },
  ])
  expect(sent.messages).toEqual([
    { role: 'system', content: '你是一个修 bug 的 agent。' },
    { role: 'user', content: '读文件' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: '先读取文件。',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '内容A' },
  ])
  expect(captured[0]?.init.headers).toMatchObject({ authorization: 'Bearer test-key' })
})

test('passes reasoning_content back on a tool-call-free assistant turn', async () => {
  let sent: Record<string, unknown> | undefined
  const adapter = makeAdapter(async (_url, init) => {
    sent = JSON.parse(String(init.body)) as Record<string, unknown>
    return new Response('data: [DONE]\n\n', { status: 200 })
  })

  await collect(adapter, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [{
      role: 'assistant',
      content: [{ type: 'text', text: '答案' }],
      thinking: '逐步推理',
    }],
  })

  expect(sent?.['messages']).toEqual([
    { role: 'assistant', content: '答案', reasoning_content: '逐步推理' },
  ])
})

test('non-2xx response throws with status and body excerpt', async () => {
  const adapter = makeAdapter(fixtureTransport(401))
  const error = await collect(adapter, emptyRequest).catch(value => value as unknown)
  expect(error).toBeInstanceOf(LlmError)
  expect(error).toMatchObject({
    message: expect.stringContaining('deepseek api error 401'),
    kind: 'authentication',
    retryable: false,
    status: 401,
  })
})

test('classifies rate limits, server failures, and transport failures as retryable', async () => {
  for (const [status, kind] of [[429, 'rate-limit'], [503, 'server']] as const) {
    const error = await collect(makeAdapter(fixtureTransport(status)), emptyRequest).catch(value => value as unknown)
    expect(error).toMatchObject({ kind, retryable: true, status })
  }

  const networkError = await collect(makeAdapter(async () => { throw new TypeError('fetch failed') }), emptyRequest)
    .catch(value => value as unknown)
  expect(networkError).toMatchObject({ kind: 'network', retryable: true })
})

test('an already-aborted signal rejects the stream', async () => {
  const adapter = makeAdapter(fixtureTransport())
  const controller = new AbortController()
  controller.abort()
  await expect(collect(adapter, emptyRequest, controller.signal)).rejects.toThrow('aborted')
})
