import type { SessionEvent, SessionLog } from '@cubus/session'
import type { Tool } from '@cubus/tool-registry'

/** 工具名：产品必须在 manifest.tools 里申报它（用 withSessionLogTools 会自动加上）。 */
export const READ_SESSION_LOG_TOOL = 'read_session_log'

/** 一次返回的字符上限（工具输出分页）与条数上限（消息列表）。 */
export const TOOL_OUTPUT_PAGE_CHARS = 8_000
export const TOOL_OUTPUT_MAX_CHARS = 16_000
export const MESSAGES_MAX_ENTRIES = 40
export const MESSAGE_PREVIEW_CHARS = 300

function stringField(args: unknown, name: string): string {
  if (typeof args !== 'object' || args === null || !(name in args)) throw new Error('missing argument: ' + name)
  const value = (args as Record<string, unknown>)[name]
  if (typeof value !== 'string') throw new Error('argument ' + name + ' must be a string')
  return value
}

function optionalInt(args: unknown, name: string): number | undefined {
  if (typeof args !== 'object' || args === null || !(name in args)) return undefined
  const value = (args as Record<string, unknown>)[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('argument ' + name + ' must be a non-negative integer')
  }
  return value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * `read_session_log`：把"进上下文时被压缩掉的东西"读回来。
 *
 * 背景（S3.2）：投影对超大工具结果只给模型**首尾预览 + id**，全文仍在日志里；
 * 被摘要替代的历史消息同理。这个工具让"逃生通道"成立 —— 模型想较真时可以自己读回，
 * 而不是只能相信摘要。
 *
 * 两条纪律：**只读本会话**（服务就是本会话的 SessionLog）、**输出有上限**（分页/条数封顶），
 * 否则它自己就成了把窗口撑爆的那条路。
 */
export function createReadSessionLogTool(log: SessionLog): Tool {
  return {
    name: READ_SESSION_LOG_TOOL,
    description:
      'Read back parts of this session log that were compressed out of the context: ' +
      'kind "tool_output" fetches the full text of a tool result by id (the truncated preview shows the id), ' +
      'kind "messages" lists the raw user/assistant/tool-result entries of a log range. ' +
      'Output is capped and paginated - pass offset to continue.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tool_output', 'messages'], description: 'what to read back' },
        id: { type: 'string', description: 'tool call id, required for kind=tool_output' },
        offset: { type: 'integer', description: 'character offset for kind=tool_output (default 0)' },
        limit: { type: 'integer', description: 'max characters, default 8000, capped at 16000' },
        from: { type: 'integer', description: 'first log index for kind=messages (default 0)' },
        to: { type: 'integer', description: 'exclusive last log index for kind=messages (default end)' },
      },
      required: ['kind'],
    },
    async execute(args): Promise<string> {
      const kind = stringField(args, 'kind')
      const { events } = await log.read()
      if (kind === 'tool_output') return readToolOutput(events, stringField(args, 'id'), args)
      if (kind === 'messages') return readMessages(events, args)
      throw new Error('argument kind must be "tool_output" or "messages"')
    },
  }
}

function readToolOutput(events: readonly SessionEvent[], id: string, args: unknown): string {
  const event = events.find(candidate => candidate.type === 'tool/result' && candidate.id === id)
  if (event?.type !== 'tool/result') {
    throw new Error('no tool result with id ' + id + '（预览里的 id 就是 tool/result 的 id）')
  }
  const text = event.output.text
  const offset = clamp(optionalInt(args, 'offset') ?? 0, 0, text.length)
  const limit = clamp(optionalInt(args, 'limit') ?? TOOL_OUTPUT_PAGE_CHARS, 1, TOOL_OUTPUT_MAX_CHARS)
  const slice = text.slice(offset, offset + limit)
  const rest = text.length - (offset + slice.length)
  return '工具输出 id=' + id + '：共 ' + String(text.length) + ' 字符，本次返回 [' + String(offset) + ', ' +
    String(offset + slice.length) + ')' + (rest > 0 ? '，还有 ' + String(rest) + ' 字符（用 offset=' +
    String(offset + slice.length) + ' 继续）' : '（已到结尾）') + '\n\n' + slice
}

function readMessages(events: readonly SessionEvent[], args: unknown): string {
  const from = clamp(optionalInt(args, 'from') ?? 0, 0, events.length)
  const to = clamp(optionalInt(args, 'to') ?? events.length, from, events.length)
  const lines: string[] = []
  let skipped = 0
  for (let index = from; index < to; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    const rendered = renderMessage(event)
    if (rendered === undefined) continue
    if (lines.length >= MESSAGES_MAX_ENTRIES) {
      skipped += 1
      continue
    }
    lines.push('[#' + String(index) + '] ' + rendered)
  }
  if (lines.length === 0) return '日志 [' + String(from) + ', ' + String(to) + ') 里没有消息类事件。'
  return '日志 [' + String(from) + ', ' + String(to) + ') 的原始消息（本次 ' + String(lines.length) + ' 条' +
    (skipped > 0 ? '，另有 ' + String(skipped) + ' 条未显示 —— 用 from/to 缩小范围' : '') + '）：\n' +
    lines.join('\n')
}

function renderMessage(event: SessionEvent): string | undefined {
  if (event.type === 'user/message') return 'user: ' + preview(textOf(event.content))
  if (event.type === 'assistant/message') return 'assistant: ' + preview(textOf(event.content))
  if (event.type === 'tool/result') return 'tool/result(' + event.id + '): ' + preview(event.output.text)
  return undefined
}

function textOf(content: readonly { type: 'text'; text: string }[]): string {
  return content.map(block => block.text).join('')
}

function preview(text: string): string {
  return text.length <= MESSAGE_PREVIEW_CHARS ? text : text.slice(0, MESSAGE_PREVIEW_CHARS) + '…（' + String(text.length) + ' 字符）'
}
