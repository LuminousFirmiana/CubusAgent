import type { ProjectedMessage, ProjectedRequest, ProjectedToolCall, SessionEvent } from './types.ts'

/**
 * 从日志事件推导模型可见的消息序列（投影，纯函数）。
 *
 * 规则：
 * - user/message -> 用户消息；assistant/message -> 助手消息（权威正文），
 *   并携带同 stepId 的 tool/call 事件重建出的 toolCalls。
 * - tool/call 与 tool/result 按 id 配对成一条工具结果消息；
 *   有 call 无 result（仍在执行）或有 result 无 call（孤立）都不投影。
 * - request/header、assistant/chunk 与 turn/step 边界事件不参与消息投影。
 * - **context/compacted（S3.1）只改投影不改历史**：取最后一个压缩边界，消息序列变成
 *   "[summary 作为一条 user 消息] + [keepFrom, …] 里逐字保留的消息"。没有压缩事件时行为与从前一致。
 *
 * 纯函数保证：同一份日志永远推导出同一份消息序列（确定性）。
 */
export function deriveMessages(events: SessionEvent[]): ProjectedMessage[] {
  const boundary = lastCompactionIndex(events)
  if (boundary === -1) return projectRange(events)

  const event = events[boundary]
  if (event?.type !== 'context/compacted') return projectRange(events)
  const keepFrom = clampIndex(event.keepFrom, boundary)
  // 摘要替代的是 [0, keepFrom)；keepFrom 之后（含边界之后的追加）逐字保留。
  const kept = events.slice(keepFrom, boundary)
  const after = events.slice(boundary + 1)
  return [
    { role: 'user', content: [{ type: 'text', text: event.summary }] },
    ...projectRange([...kept, ...after]),
  ]
}

/** 最后一个压缩边界的下标；没有则 -1。 */
export function lastCompactionIndex(events: SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'context/compacted') return index
  }
  return -1
}

/**
 * 把投影边界吸附到"不会切断 tool_use ↔ tool_result 配对"的位置。
 *
 * 今天只有一种需要吸附的情形：边界正好落在某条 tool/result 上，而它的 tool/call 在边界之前
 * ——此时把边界前移到那条 tool/call，让配对完整。返回**调整后**的下标（生产者应把它记进事件）。
 */
export function snapKeepFrom(events: SessionEvent[], keepFrom: number): number {
  const index = clampIndex(keepFrom, events.length)
  const event = events[index]
  if (event?.type !== 'tool/result') return index
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = events[cursor]
    if (candidate?.type === 'tool/call' && candidate.id === event.id) return cursor
  }
  return index
}

function clampIndex(value: number, upperBound: number): number {
  if (!Number.isInteger(value) || value < 0) return 0
  return value > upperBound ? upperBound : value
}

/** 一段事件的消息投影（不含压缩语义）。 */
function projectRange(events: SessionEvent[]): ProjectedMessage[] {
  // 先收集每个 step 的工具调用：assistant 消息的 toolCalls 从它们重建
  const callsByStep = new Map<string, ProjectedToolCall[]>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const list = callsByStep.get(event.stepId)
      if (list) {
        list.push({ id: event.id, name: event.name, args: event.args })
      } else {
        callsByStep.set(event.stepId, [{ id: event.id, name: event.name, args: event.args }])
      }
    }
  }

  const seenCalls = new Set<string>()
  const messages: ProjectedMessage[] = []

  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        messages.push({ role: 'user', content: event.content })
        break
      case 'assistant/message': {
        const toolCalls = callsByStep.get(event.stepId)
        messages.push({
          role: 'assistant',
          content: event.content,
          ...(event.thinking === undefined ? {} : { thinking: event.thinking }),
          ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        })
        break
      }
      case 'tool/call':
        seenCalls.add(event.id)
        break
      case 'tool/result':
        if (seenCalls.has(event.id)) {
          messages.push({
            role: 'tool-result',
            toolCallId: event.id,
            content: event.output.text,
            ok: event.ok,
          })
        }
        break
      default:
        // turn/*, step/*, request/header, assistant/chunk：不进消息投影
        break
    }
  }
  return messages
}

/**
 * 重建指定 step 实际发出的 provider-neutral 请求。
 * 消息投影只读取 header 之前的前缀，因此稍后追加的回复不会污染历史请求。
 */
export function deriveRequest(events: SessionEvent[], stepId: string): ProjectedRequest | undefined {
  const headerIndex = events.findIndex(event => event.type === 'request/header' && event.stepId === stepId)
  const event = events[headerIndex]
  if (event?.type !== 'request/header') return undefined

  return {
    provider: event.header.provider,
    model: event.header.model,
    messages: deriveMessages(events.slice(0, headerIndex)),
    ...(event.header.systemPrompt === undefined ? {} : { systemPrompt: event.header.systemPrompt }),
    ...(event.header.tools === undefined ? {} : { tools: event.header.tools }),
  }
}