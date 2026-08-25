import type { LlmAdapter, LlmChunk, LlmRequest, LlmToolCall } from './types.ts'
import { LlmError } from './errors.ts'

/**
 * transport 注入点：默认用全局 fetch；测试注入重放 fixture 的替身。
 * 真模型进测试但不花钱：录制一次响应，CI 里无 key 重放。
 */
export type Transport = (url: string, init: RequestInit) => Promise<Response>

export interface DeepSeekConfig {
  baseUrl: string
  apiKey: string
  model: string
  transport?: Transport
}

function abortError(): Error {
  return new DOMException('aborted', 'AbortError')
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === 'AbortError')
}

function httpError(status: number, body: string): LlmError {
  const message = `deepseek api error ${status}: ${body.slice(0, 200)}`
  if (status === 429) {
    return new LlmError(message, { kind: 'rate-limit', retryable: true, status })
  }
  if (status >= 500) {
    return new LlmError(message, { kind: 'server', retryable: true, status })
  }
  if (status === 401 || status === 403) {
    return new LlmError(message, { kind: 'authentication', retryable: false, status })
  }
  return new LlmError(message, { kind: 'request', retryable: false, status })
}

/** SSE 载荷的线上格式（OpenAI-compatible）。 */
interface SseDelta {
  content?: string
  reasoning_content?: string
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[]
}

interface SseChoice {
  delta?: SseDelta
  finish_reason?: string | null
}

interface SsePayload {
  choices?: SseChoice[]
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SsePayload, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    if (signal.aborted) throw abortError()
    const { done, value } = await reader.read()
    if (done) break
    // 注：这里按 \n 分行；跨块边界出现 \r\n 的极端情况 v1 不处理（fixture 与 DeepSeek 均用 \n）
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const dataLines = rawEvent.split('\n').filter(l => l.startsWith('data:'))
      if (dataLines.length === 0) continue
      const payload = dataLines.map(l => l.slice(5).trimStart()).join('\n')
      if (payload === '[DONE]') return
      const parsed: unknown = JSON.parse(payload)
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('invalid sse payload')
      }
      yield parsed as SsePayload
    }
  }
}

/** 投影消息 -> OpenAI 消息格式（DeepSeek 兼容）；systemPrompt 前置为 system 消息。 */
function toOpenAiMessages(request: LlmRequest): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  if (request.systemPrompt !== undefined) {
    out.push({ role: 'system', content: request.systemPrompt })
  }
  for (const message of request.messages) {
    switch (message.role) {
      case 'user':
        out.push({ role: 'user', content: message.content.map(b => b.text).join('') })
        break
      case 'assistant':
        out.push({
          role: 'assistant',
          content: message.content.map(b => b.text).join(''),
          ...(message.thinking ? { reasoning_content: message.thinking } : {}),
          ...(message.toolCalls
            ? {
                tool_calls: message.toolCalls.map(call => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              }
            : {}),
        })
        break
      case 'tool-result':
        out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content })
        break
    }
  }
  return out
}

/**
 * DeepSeek 适配器：OpenAI-compatible /chat/completions 流式。
 * - delta.content -> 正文；delta.reasoning_content -> 思考；
 * - delta.tool_calls 按 index 累积（参数分片拼接），finish_reason=tool_calls 时拼装。
 */
export class DeepSeekAdapter implements LlmAdapter {
  readonly provider = 'deepseek'
  readonly model: string

  private readonly config: DeepSeekConfig

  constructor(config: DeepSeekConfig) {
    this.config = config
    this.model = config.model
  }

  async *stream(request: LlmRequest, signal: AbortSignal): AsyncGenerator<LlmChunk, void, void> {
    const transport = this.config.transport ?? fetch
    const url = this.config.baseUrl.replace(/\/$/, '') + '/chat/completions'

    let response: Response
    try {
      response = await transport(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model,
          messages: toOpenAiMessages(request),
          stream: true,
          ...(request.tools === undefined
            ? {}
            : {
                tools: request.tools.map(tool => ({
                  type: 'function',
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }),
        }),
        signal,
      })
    } catch (error) {
      if (isAbort(error, signal)) throw error
      throw new LlmError(`deepseek network error: ${error instanceof Error ? error.message : String(error)}`, {
        kind: 'network',
        retryable: true,
        cause: error,
      })
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw httpError(response.status, text)
    }
    if (!response.body) {
      throw new LlmError('deepseek api returned no body', { kind: 'protocol', retryable: false })
    }

    const toolAcc = new Map<number, { id: string; name: string; argsText: string }>()
    try {
      for await (const payload of parseSse(response.body, signal)) {
        const choice = payload.choices?.[0]
        const delta = choice?.delta
        const finishReason = choice?.finish_reason

        const chunk: LlmChunk = {}
        if (typeof delta?.content === 'string' && delta.content !== '') {
          chunk.delta = delta.content
        }
        if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
          chunk.thinkingDelta = delta.reasoning_content
        }

        if (delta?.tool_calls) {
          for (const piece of delta.tool_calls) {
            const acc = toolAcc.get(piece.index) ?? { id: '', name: '', argsText: '' }
            if (piece.id) acc.id = piece.id
            if (piece.function?.name) acc.name += piece.function.name
            if (piece.function?.arguments) acc.argsText += piece.function.arguments
            toolAcc.set(piece.index, acc)
          }
        }

        if (finishReason === 'tool_calls') {
          const calls: LlmToolCall[] = []
          const sorted = [...toolAcc.entries()].sort((a, b) => a[0] - b[0])
          for (const [, acc] of sorted) {
            let args: unknown = acc.argsText
            try {
              args = JSON.parse(acc.argsText)
            } catch {
              // 参数不是合法 JSON 时保留原文（模型偶尔输出坏 JSON）
            }
            calls.push({ id: acc.id, name: acc.name, args })
          }
          chunk.toolCalls = calls
        }

        if (chunk.delta || chunk.thinkingDelta || chunk.toolCalls) yield chunk
      }
    } catch (error) {
      if (isAbort(error, signal) || error instanceof LlmError) throw error
      if (error instanceof SyntaxError) {
        throw new LlmError(`deepseek protocol error: ${error.message}`, {
          kind: 'protocol',
          retryable: false,
          cause: error,
        })
      }
      throw new LlmError(`deepseek stream error: ${error instanceof Error ? error.message : String(error)}`, {
        kind: 'network',
        retryable: true,
        cause: error,
      })
    }
  }
}
