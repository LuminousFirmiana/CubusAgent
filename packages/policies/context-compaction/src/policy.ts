import type { LlmAdapter, LlmRequest } from '@cubus/llm'
import { deriveMessages, lastCompactionIndex, snapKeepFrom } from '@cubus/session'
import type { ProjectedMessage, SessionEvent, SessionLog } from '@cubus/session'

/** 摘要模板版本：进事件的 `input.template`，模板改了要换版本号。 */
export const COMPACT_TEMPLATE_V1 = 'compact-v1'

/** 摘要请求的系统提示。只描述"怎么总结"，不夹带任何产品语义。 */
export const COMPACTION_SYSTEM_PROMPT = [
  'You compress an agent session so it can continue with a smaller context.',
  'Write a compact but complete summary of the conversation below, in the language it uses.',
  'Keep: the user\'s explicit requests and constraints, decisions made and why, files and paths touched,',
  'commands that were run and their outcomes, current state, and anything still open or unverified.',
  'Drop: repetition, intermediate reasoning that led nowhere, and tool output that can be re-read.',
  'Answer with the summary only - no preamble, no headings like "summary:".',
  // 实测：deepseek-chat 在无工具的请求里也会把工具调用模板当正文吐出来（<｜｜DSML｜｜ calls>…），
  // 这种噪声会被摘要原样带进下一次上下文，所以明确禁止。
  'Write plain prose only: never emit tool-call markup, XML tags, or function-call syntax.',
].join('\n')

export interface ContextCompactionOptions {
  readonly log: SessionLog
  readonly adapter: LlmAdapter
  /** 上下文窗口（token）；app 最清楚这个值。 */
  readonly contextWindow: number
  /** 触发比例：投影占用超过 `contextWindow × ratio` 才压（默认 0.8）。 */
  readonly thresholdRatio?: number
  /** 保留区下限与上限（token 估算）；以及至少保留几条消息。 */
  readonly keepRecentTokens?: number
  readonly maxKeepTokens?: number
  readonly minKeepMessages?: number
  /** 字符 → token 的估算比例（无 usage 时的兜底；默认 4）。 */
  readonly charsPerToken?: number
  /** 连续失败多少次后熔断（默认 3）。 */
  readonly maxConsecutiveFailures?: number
  /** 摘要输入的最大字符数（防止"为了压缩而超窗"）；默认由窗口推算。 */
  readonly maxInputChars?: number
  readonly now?: () => number
}

export interface CompactionOutcome {
  readonly compacted: boolean
  readonly reason: 'below-threshold' | 'no-progress' | 'too-small' | 'circuit-open' | 'summarized' | 'failed'
  readonly message: string
  /** 压缩前/后的估算 token（compacted 时有意义）。 */
  readonly before?: number
  readonly after?: number
}

const DEFAULTS = {
  thresholdRatio: 0.8,
  keepRecentTokens: 8_000,
  maxKeepTokens: 24_000,
  minKeepMessages: 4,
  charsPerToken: 4,
  maxConsecutiveFailures: 3,
}

/**
 * 上下文压缩策略（S3.3）：
 *
 * 由循环在每次 step 拼请求之前 await 一次（`LoopConfig.beforeRequest`）。它只做一件事：
 * **判断这次请求会不会撞窗口，会的话用一次模型调用换一个 `context/compacted` 事件**。
 *
 * 三条纪律：
 * 1. 触发与保留边界都基于**投影**（模型真正看到的东西），不是原始日志长度；
 * 2. 失败不阻断任务（宁可撞窗口，也不要卡死）：重试有限、连续失败熔断；
 * 3. 每次压缩都必须**有进展**（比上一个边界更靠后），否则跳过 —— 否则会反复摘要同一段。
 */
export class ContextCompactionPolicy {
  private readonly log: SessionLog
  private readonly adapter: LlmAdapter
  private readonly contextWindow: number
  private readonly thresholdRatio: number
  private readonly keepRecentTokens: number
  private readonly maxKeepTokens: number
  private readonly minKeepMessages: number
  private readonly charsPerToken: number
  private readonly maxConsecutiveFailures: number
  private readonly maxInputChars: number
  private failures = 0
  private last: CompactionOutcome | undefined

  constructor(options: ContextCompactionOptions) {
    this.log = options.log
    this.adapter = options.adapter
    this.contextWindow = options.contextWindow
    this.thresholdRatio = options.thresholdRatio ?? DEFAULTS.thresholdRatio
    // 保留预算必须由窗口推导出上界：窗口只有 3k 时"保留 8k token 的尾巴"是荒谬的
    // （压缩后反而更超窗）。默认值服务于大窗口，小窗口按比例收紧。
    this.keepRecentTokens = Math.min(
      options.keepRecentTokens ?? DEFAULTS.keepRecentTokens,
      Math.floor(this.contextWindow * 0.5),
    )
    this.maxKeepTokens = Math.min(
      options.maxKeepTokens ?? DEFAULTS.maxKeepTokens,
      Math.floor(this.contextWindow * 0.6),
    )
    this.minKeepMessages = options.minKeepMessages ?? DEFAULTS.minKeepMessages
    this.charsPerToken = options.charsPerToken ?? DEFAULTS.charsPerToken
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures
    this.maxInputChars = options.maxInputChars ?? Math.floor(this.contextWindow * this.charsPerToken * 0.6)
  }

  /** 最近一次判断的结果（工作台/CLI 展示用）。 */
  get lastOutcome(): CompactionOutcome | undefined {
    return this.last
  }

  get consecutiveFailures(): number {
    return this.failures
  }

  async prepareNextRequest(): Promise<void> {
    const { events } = await this.log.read()
    const outcome = await this.compactIfNeeded(events)
    this.last = outcome
  }

  private async compactIfNeeded(events: readonly SessionEvent[]): Promise<CompactionOutcome> {
    if (this.failures >= this.maxConsecutiveFailures) {
      return { compacted: false, reason: 'circuit-open', message: '连续失败已达上限，暂停自动压缩' }
    }
    const before = this.projectedTokens(events)
    if (before < this.contextWindow * this.thresholdRatio) {
      return { compacted: false, reason: 'below-threshold', message: '投影占用 ' + String(before) + ' token，未到阈值' }
    }

    const keepFrom = this.chooseKeepFrom(events)
    const previous = previousBoundary(events)
    if (keepFrom <= previous) {
      return { compacted: false, reason: 'no-progress', message: '保留边界无法前移（没有可压缩的新内容）' }
    }

    const prefix = renderMessages(deriveMessages(events.slice(0, keepFrom)))
    if (prefix.trim() === '') {
      return { compacted: false, reason: 'too-small', message: '待摘要区间为空' }
    }

    let summary: string | undefined
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
    let lastError = ''
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await this.summarize(prefix)
        if (result.summary.trim() === '') throw new Error('模型返回了空摘要')
        summary = result.summary
        usage = result.usage
        break
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    if (summary === undefined) {
      this.failures += 1
      return {
        compacted: false,
        reason: 'failed',
        message: '摘要失败（第 ' + String(this.failures) + ' 次连续失败）：' + lastError,
      }
    }
    this.failures = 0

    const kept = deriveMessages(events.slice(keepFrom))
    const after = estimateTokens(summary, this.charsPerToken) +
      kept.reduce((sum, message) => sum + messageTokens(message, this.charsPerToken), 0)
    await this.log.append({
      type: 'context/compacted',
      summary,
      keepFrom,
      reason: 'threshold',
      input: { from: 0, to: keepFrom, template: COMPACT_TEMPLATE_V1 },
      ...(usage === undefined ? {} : { usage }),
      before,
      after,
    })
    return {
      compacted: true,
      reason: 'summarized',
      message: '压缩 ' + String(keepFrom) + ' 条事件：' + String(before) + ' → ' + String(after) + ' token',
      before,
      after,
    }
  }

  /** 一次摘要调用：输入是"待压缩区间的投影"，输出是摘要正文。 */
  private async summarize(prefix: string): Promise<{ summary: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
    const input = prefix.length > this.maxInputChars
      // 两头都保：开头是用户请求与目标，结尾是当前状态；省略中间。
      ? prefix.slice(0, Math.floor(this.maxInputChars / 2)) +
        '\n\n（中间内容已省略）\n\n' +
        prefix.slice(prefix.length - Math.floor(this.maxInputChars / 2))
      : prefix
    const request: LlmRequest = {
      provider: this.adapter.provider,
      model: this.adapter.model,
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
    }
    const controller = new AbortController()
    let summary = ''
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined
    for await (const chunk of this.adapter.stream(request, controller.signal)) {
      if (chunk.delta !== undefined) summary += chunk.delta
      if (chunk.usage !== undefined) usage = chunk.usage
    }
    return usage === undefined ? { summary } : { summary, usage }
  }

  /** 投影占用（token 估算）：有 usage 锚点就"锚点 + 之后新增"，否则整体估算。 */
  private projectedTokens(events: readonly SessionEvent[]): number {
    const anchorIndex = lastUsageIndex(events)
    if (anchorIndex === -1) {
      return deriveMessages(events).reduce((sum, message) => sum + messageTokens(message, this.charsPerToken), 0)
    }
    const anchor = events[anchorIndex]
    const base = anchor?.type === 'assistant/message' ? anchor.usage?.totalTokens ?? 0 : 0
    const tail = deriveMessages(events.slice(anchorIndex + 1))
      .reduce((sum, message) => sum + messageTokens(message, this.charsPerToken), 0)
    return base + tail
  }

  /**
   * 保留边界：从尾部往回走，直到保留区达到 `keepRecentTokens` 或 `minKeepMessages` 条，
   * 且不超过 `maxKeepTokens`；最后做配对吸附。
   */
  private chooseKeepFrom(events: readonly SessionEvent[]): number {
    const messages = deriveMessages(events)
    if (messages.length <= this.minKeepMessages) return -1
    let kept = 0
    let keptCount = 0
    let boundary = events.length
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === undefined) continue
      const size = eventTokens(event, this.charsPerToken)
      if (size === 0) continue
      // 硬上限优先于"至少保留几条"的偏好：窗口小时保留区必须让路，否则压缩后仍然超窗。
      if (keptCount > 0 && kept + size > this.maxKeepTokens) break
      kept += size
      keptCount += 1
      boundary = index
      if (kept >= this.keepRecentTokens && keptCount >= this.minKeepMessages) break
    }
    return snapKeepFrom(events, boundary)
  }
}

function previousBoundary(events: readonly SessionEvent[]): number {
  const index = lastCompactionIndex(events)
  const event = index === -1 ? undefined : events[index]
  return event?.type === 'context/compacted' ? event.keepFrom : -1
}

function lastUsageIndex(events: readonly SessionEvent[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'assistant/message' && event.usage !== undefined) return index
  }
  return -1
}

function estimateTokens(text: string, charsPerToken: number): number {
  return Math.ceil(text.length / charsPerToken)
}

function messageTokens(message: ProjectedMessage, charsPerToken: number): number {
  if (message.role === 'tool-result') return estimateTokens(message.content, charsPerToken)
  const text = message.content.map(block => block.text).join('')
  return estimateTokens(text, charsPerToken)
}

/** 估算一条事件"进上下文"的体量（只算会投影的事件）。 */
function eventTokens(event: SessionEvent, charsPerToken: number): number {
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    return estimateTokens(event.content.map(block => block.text).join(''), charsPerToken)
  }
  if (event.type === 'tool/result') return estimateTokens(event.output.text, charsPerToken)
  return 0
}

/**
 * 工具结果在**摘要输入**里只保留这么长：摘要要的是"发生了什么、决定了什么"，
 * 不是原始输出（那玩意儿全文还在日志里，模型可以用 read_session_log 读回）。
 * 实测教训：88k 的工具结果会把摘要输入整个吃掉，模型最后只总结出"全是占位符"。
 */
export const SUMMARY_TOOL_RESULT_PREVIEW_CHARS = 400

/** 把一段投影渲染成摘要请求的正文。 */
export function renderMessages(
  messages: readonly ProjectedMessage[],
  toolResultPreviewChars: number = SUMMARY_TOOL_RESULT_PREVIEW_CHARS,
): string {
  return messages.map(message => {
    if (message.role === 'user') return 'user: ' + message.content.map(block => block.text).join('')
    if (message.role === 'assistant') {
      const text = message.content.map(block => block.text).join('')
      const calls = (message.toolCalls ?? []).map(call => call.name + '(' + JSON.stringify(call.args) + ')').join(' ')
      return 'assistant: ' + text + (calls === '' ? '' : ' [工具调用] ' + calls)
    }
    const preview = message.content.length <= toolResultPreviewChars
      ? message.content
      : message.content.slice(0, toolResultPreviewChars) + '…（共 ' + String(message.content.length) + ' 字符，已省略）'
    return 'tool(' + message.toolCallId + (message.ok ? '' : ', 失败') + '): ' + preview
  }).join('\n\n')
}