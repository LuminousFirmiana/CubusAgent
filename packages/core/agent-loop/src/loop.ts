import { randomUUID } from 'node:crypto'
import type { LlmToolCall } from '@cubus/llm'
import { deriveMessages } from '@cubus/session'
import type { ContentBlock, SessionLogFile } from '@cubus/session'
import type { InboxItem, LoopConfig, Tool } from './types.ts'

/**
 * 循环驱动：turn/step 语义 + inbox + 取消 + 全事件落日志。
 *
 * 一个 turn = 从认领一条用户输入到不再欠账（没有待回喂的工具结果、
 * 也没有新的模型请求）；一个 step = 一次模型请求 + 它触发的工具执行。
 *
 * 本类与 cordis 无关（pi 式朴素注入）：S1.3 会把同一个循环挂成插件，
 * 机制不变，只是换挂法。
 */
export class Loop {
  private readonly inbox: InboxItem[] = []
  private running = false
  private abort: AbortController | null = null
  private readonly log: SessionLogFile
  private readonly adapter: LoopConfig['adapter']
  private readonly tools = new Map<string, Tool>()
  private readonly generateId: () => string

  constructor(config: LoopConfig) {
    this.log = config.log
    this.adapter = config.adapter
    for (const tool of config.tools) this.tools.set(tool.name, tool)
    this.generateId = config.generateId ?? randomUUID
  }

  /**
   * 提交一条用户输入：入队；若当前没有正在跑的回合，立即驱动到闭环。
   * 回合进行中新提交的输入排队，当前回合结束后自动处理。
   */
  async submit(content: ContentBlock[]): Promise<void> {
    this.inbox.push({ messageId: this.generateId(), content })
    if (this.running) return
    this.running = true
    try {
      while (true) {
        const item = this.inbox.shift()
        if (!item) break
        await this.runTurn(item)
      }
    } finally {
      this.running = false
    }
  }

  /** 取消当前回合（回合之间调用是空操作）。 */
  cancel(): void {
    this.abort?.abort(new Error('cancelled'))
  }

  private async runTurn(item: InboxItem): Promise<void> {
    const turnId = this.generateId()
    await this.log.append({ type: 'turn/start', turnId })
    await this.log.append({ type: 'user/message', messageId: item.messageId, content: item.content })

    this.abort = new AbortController()
    try {
      while (true) {
        const stepDone = await this.runStep(turnId)
        if (stepDone) break
      }
    } finally {
      await this.log.append({ type: 'turn/end', turnId })
      this.abort = null
    }
  }

  /** 跑一个 step。返回 true = 回合闭环；false = 需要下一步（工具结果待回喂）。 */
  private async runStep(turnId: string): Promise<boolean> {
    const stepId = this.generateId()
    await this.log.append({ type: 'step/start', stepId, turnId })

    const { events } = await this.log.read()
    const messages = deriveMessages(events)

    let text = ''
    let thinkingText = ''
    const toolCalls: LlmToolCall[] = []
    let aborted = false

    try {
      for await (const chunk of this.adapter.stream({ messages }, this.abort!.signal)) {
        if (this.abort!.signal.aborted) {
          aborted = true
          break
        }
        if (chunk.delta) {
          text += chunk.delta
          await this.log.append({ type: 'assistant/chunk', stepId, delta: chunk.delta })
        }
        if (chunk.thinkingDelta) {
          thinkingText += chunk.thinkingDelta
          await this.log.append({ type: 'assistant/chunk', stepId, thinkingDelta: chunk.thinkingDelta })
        }
        if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls)
      }
    } catch (error) {
      if (this.abort!.signal.aborted) {
        aborted = true
      } else {
        throw error
      }
    }

    if (aborted) {
      // rc.8 取消语义：只有流式输出过可见内容，才落 interrupted 前缀；
      // 未派发的工具调用不落盘。
      if (text !== '' || thinkingText !== '') {
        await this.log.append({
          type: 'assistant/message',
          messageId: this.generateId(),
          stepId,
          content: text ? [{ type: 'text', text }] : [],
          interrupted: true,
        })
      }
      await this.log.append({ type: 'step/end', stepId })
      return true
    }

    // 正常收束：完整回复 + 工具调用落盘
    await this.log.append({
      type: 'assistant/message',
      messageId: this.generateId(),
      stepId,
      content: text ? [{ type: 'text', text }] : [],
    })
    for (const call of toolCalls) {
      await this.log.append({ type: 'tool/call', id: call.id, stepId, name: call.name, args: call.args })
    }

    if (toolCalls.length === 0) {
      await this.log.append({ type: 'step/end', stepId })
      return true
    }

    // 执行工具，结果回喂（下一个 step 的投影会自动包含它们）。
    // step/end 在工具结果之后：step = 一次模型请求 + 它触发的工具执行。
    for (const call of toolCalls) {
      const tool = this.tools.get(call.name)
      let ok = true
      let outputText: string
      if (!tool) {
        ok = false
        outputText = `unknown tool: ${call.name}`
      } else {
        try {
          outputText = await tool.execute(call.args)
        } catch (error) {
          ok = false
          outputText = error instanceof Error ? error.message : String(error)
        }
      }
      await this.log.append({ type: 'tool/result', id: call.id, ok, output: { text: outputText } })
    }
    await this.log.append({ type: 'step/end', stepId })
    return false
  }
}

