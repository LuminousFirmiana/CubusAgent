import type { ProjectedMessage, ProjectedRequest, ProjectedToolCall, SessionEvent } from './types.ts'

/** 单条工具结果进投影的上限（字符）；超过就换成首尾预览。 */
export const PROJECTED_TOOL_RESULT_MAX_CHARS = 24_000
/** 同一个 step 内工具结果合计上限（字符）。 */
export const PROJECTED_STEP_TOOL_RESULTS_MAX_CHARS = 96_000
/** 预览保留的头部/尾部字符数。 */
export const PREVIEW_HEAD_CHARS = 8_000
export const PREVIEW_TAIL_CHARS = 8_000

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
  const stepByCall = new Map<string, string>()
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
        stepByCall.set(event.id, event.stepId)
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
  applyToolResultBudget(messages, stepByCall)
  return messages
}

/**
 * 第一层压缩：工具结果预算（S3.2）。**只改投影，不改日志** —— 全文仍在 `tool/result` 事件里，
 * 模型可以按预览里给的 id 用 `read_session_log` 读回。
 *
 * 两条规则（都是确定性的，纯函数）：
 * 1. 单条超过 {@link PROJECTED_TOOL_RESULT_MAX_CHARS} → 换成首尾预览；
 * 2. 同一个 step 内合计超过 {@link PROJECTED_STEP_TOOL_RESULTS_MAX_CHARS} → 从最长的开始换，直到降到预算内。
 *
 * 阈值是**投影规则常量**：改它们会改变旧日志的投影结果，因此属于"必须与版本一起做"的改动
 * （见 docs/design/context-compaction.md §3 与 versioning.md §2）。
 */
export function applyToolResultBudget(
  messages: ProjectedMessage[],
  stepByCall: ReadonlyMap<string, string>,
): void {
  const indexes: number[] = []
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool-result') continue
    indexes.push(index)
    if (message.content.length > PROJECTED_TOOL_RESULT_MAX_CHARS) {
      messages[index] = { ...message, content: previewToolResultText(message.content, message.toolCallId) }
    }
  }

  // 同一 step 的聚合预算：按长度从大到小截，保证"同样输入同样输出"
  const byStep = new Map<string, number[]>()
  for (const index of indexes) {
    const message = messages[index]
    if (message?.role !== 'tool-result') continue
    const stepId = stepByCall.get(message.toolCallId) ?? ''
    const list = byStep.get(stepId)
    if (list === undefined) byStep.set(stepId, [index])
    else list.push(index)
  }
  for (const list of byStep.values()) {
    const total = (): number => list.reduce((sum, index) => {
      const message = messages[index]
      return sum + (message?.role === 'tool-result' ? message.content.length : 0)
    }, 0)
    if (total() <= PROJECTED_STEP_TOOL_RESULTS_MAX_CHARS) continue
    const byLength = [...list].sort((left, right) => {
      const a = messages[left]
      const b = messages[right]
      const lengthA = a?.role === 'tool-result' ? a.content.length : 0
      const lengthB = b?.role === 'tool-result' ? b.content.length : 0
      return lengthB - lengthA || left - right
    })
    for (const index of byLength) {
      if (total() <= PROJECTED_STEP_TOOL_RESULTS_MAX_CHARS) break
      const message = messages[index]
      if (message?.role !== 'tool-result') continue
      if (message.content.includes(PREVIEW_MARKER)) continue
      messages[index] = { ...message, content: previewToolResultText(message.content, message.toolCallId) }
    }
  }
}

/** 预览里的标记：模型据此知道"内容被截断了、怎么读回全文"。 */
export const PREVIEW_MARKER = '[工具输出被截断]'

/** 把一条超长工具结果换成首尾预览 + 读回指引。 */
export function previewToolResultText(text: string, toolCallId: string): string {
  const head = text.slice(0, PREVIEW_HEAD_CHARS)
  const tail = text.slice(Math.max(PREVIEW_HEAD_CHARS, text.length - PREVIEW_TAIL_CHARS))
  return head +
    '\n\n' + PREVIEW_MARKER + ' 共 ' + String(text.length) + ' 字符，这里保留前 ' + String(head.length) +
    ' 与后 ' + String(tail.length) + ' 字符。完整内容用 read_session_log 读回：' +
    '{"kind":"tool_output","id":"' + toolCallId + '"}（可带 offset/limit 分页）。\n\n' +
    tail
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