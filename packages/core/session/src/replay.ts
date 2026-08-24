import type { ProjectedMessage, ProjectedToolCall, SessionEvent } from './types.ts'

/**
 * 从日志事件推导模型可见的消息序列（投影，纯函数）。
 *
 * 规则：
 * - user/message -> 用户消息；assistant/message -> 助手消息（权威正文），
 *   并携带同 stepId 的 tool/call 事件重建出的 toolCalls。
 * - tool/call 与 tool/result 按 id 配对成一条工具结果消息；
 *   有 call 无 result（仍在执行）或有 result 无 call（孤立）都不投影。
 * - assistant/chunk 与 turn/step 边界事件只服务回放保真，不参与投影。
 *
 * 纯函数保证：同一份日志永远推导出同一份消息序列（确定性）。
 */
export function deriveMessages(events: SessionEvent[]): ProjectedMessage[] {
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
        messages.push(
          toolCalls && toolCalls.length > 0
            ? { role: 'assistant', content: event.content, toolCalls }
            : { role: 'assistant', content: event.content },
        )
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
        // turn/*, step/*, assistant/chunk: 回放保真事件，不进投影
        break
    }
  }
  return messages
}

