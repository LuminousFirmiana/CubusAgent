/**
 * 会话日志词汇表 —— 宪法第一页。
 *
 * 会话日志是 append-only 的事件流：每行一个 SessionEvent（JSONL）。
 * 所有模型可见的内容都必须能从这份日志重建（不变量：model-visible ⟺ logged）。
 *
 * 词汇语义（dsh 同款命名，agent 领域的自然形状）：
 * - turn：一个"回合"，从用户输入开始、到不再欠账闭环。
 * - step：一个"步"，一次模型请求加上它触发的工具执行。
 *   一个 turn 可以包含零个或多个 step。
 */

export type TurnId = string
export type StepId = string
export type MessageId = string
export type ToolCallId = string

/** 消息内容块：v1 只有纯文本一种。 */
export type ContentBlock = { type: 'text'; text: string }

/** 工具结果：v1 只有文本输出，加一个 ok 标记。 */
export type ToolOutput = { text: string }

/** 一项模型可见的工具定义；随 request/header 落日志。 */
export interface RequestToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** 消息历史之外、构成一次模型请求的完整配置快照。 */
export interface RequestHeader {
  provider: string
  model: string
  systemPrompt?: string
  tools?: RequestToolSpec[]
}

/**
 * 会话事件的闭合联合（closed union）：
 * 十个事件类型覆盖 turn / step / request / user / assistant / tool 六个域。
 */
export type SessionEvent =
  | { type: 'turn/start'; turnId: TurnId }
  | { type: 'turn/end'; turnId: TurnId }
  | { type: 'step/start'; stepId: StepId; turnId: TurnId }
  | { type: 'step/end'; stepId: StepId }
  | {
      /** 紧邻模型调用前记录；与此前日志前缀共同重建该 step 的完整请求。 */
      type: 'request/header'
      stepId: StepId
      header: RequestHeader
    }
  | { type: 'user/message'; messageId: MessageId; content: ContentBlock[] }
  | {
      /** 模型流式输出的碎片，保真回放用：一次流可产生多个 chunk。 */
      type: 'assistant/chunk'
      stepId: StepId
      /** 正文增量；思考增量单独一个字段，互不混合。 */
      delta?: string
      thinkingDelta?: string
    }
  | {
      /** 一条完整模型回复（chunk 的收束：投影以它为准）。 */
      type: 'assistant/message'
      messageId: MessageId
      stepId: StepId
      content: ContentBlock[]
      /** 本次回复的完整思考文本；后续请求按 provider 协议原样回传。 */
      thinking?: string
      /**
       * 取消语义（吸收 dsh rc.8）：回合被中途取消时，把已送达的
       * 正文/思考前缀作为本条事件落盘并带 interrupted: true；
       * 未派发的工具调用不出现在日志里。没有这条事件的被取消回合
       * 说明没流式输出过任何可见内容。
       */
      interrupted?: true
    }
  | {
      type: 'tool/call'
      id: ToolCallId
      stepId: StepId
      name: string
      /** 工具参数：JSON 值。落日志前必须已可序列化。 */
      args: unknown
    }
  | {
      type: 'tool/result'
      id: ToolCallId
      ok: boolean
      output: ToolOutput
    }

/** 投影出的模型工具调用（从同 stepId 的 tool/call 事件重建）。 */
export type ProjectedToolCall = {
  id: ToolCallId
  name: string
  args: unknown
}

/**
 * 从日志投影出的、模型可见的消息序列（projection，纯函数输出）。
 * 投影规则：assistant/message 是权威正文与思考，assistant/chunk 只服务回放保真；
 * assistant 消息携带同 stepId 的 tool/call 事件重建出的 toolCalls
 * （真模型 API 要求 assistant 的 tool_calls 与其后的 tool 结果配对）；
 * tool/call 与 tool/result 配对成一条工具消息。
 */
export type ProjectedMessage =
  | { role: 'user'; content: ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[]; thinking?: string; toolCalls?: ProjectedToolCall[] }
  | { role: 'tool-result'; toolCallId: ToolCallId; content: string; ok: boolean }

/** 从日志某个 request/header 位置重建出的完整 provider-neutral 请求。 */
export interface ProjectedRequest extends RequestHeader {
  messages: ProjectedMessage[]
}
