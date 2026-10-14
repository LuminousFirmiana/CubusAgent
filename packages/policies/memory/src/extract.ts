import type { LlmAdapter, LlmRequest } from '@cubus/llm'
import type { MemoryEntry } from './store.ts'
import type { MemoryStore } from './store.ts'

/** 提炼模板版本：没有 tags 的候选会带上它（模板改了要换版本）。 */
export const EXTRACT_TEMPLATE_V1 = 'extract-v1'

/** 代码围栏（三个反引号）——用常量拼出来，免得源码里再出现反引号。 */
const FENCE = String.fromCharCode(96).repeat(3)

/**
 * 提炼用的系统提示。
 *
 * 刻意"窄"：只提炼**下次会话仍然成立**的事实，并要求输出 JSON 数组（可解析）。
 * 明确禁止记录临时任务状态（"正在跑测试"这种下次就没用了）。
 */
export const EXTRACT_SYSTEM_PROMPT = [
  'You maintain the long-term memory of a coding agent.',
  'Read the conversation and list only facts that will still be true and useful in a FUTURE session:',
  'durable decisions and their reasons, user preferences and constraints, project conventions,',
  'names, paths, flags, ids, and interfaces that were agreed on.',
  'Never record: transient task state, what was just done, tool output, or anything already obvious from the code.',
  'Answer with a JSON array only - each item {"text": "...", "tags": ["..."]} - and an empty array [] if nothing qualifies.',
  'Write each text as one self-contained sentence in the language of the conversation.',
].join('\n')

/** 会话末尾那条"维护指令"：它本身也是一条正常 user 消息，因此整次提炼在日志里可回放。 */
export const EXTRACT_INSTRUCTION = [
  '（系统维护请求，与上面的任务无关）',
  '请回顾本次会话，把值得长期记住的事实提炼成 JSON 数组：',
  '格式 [{"text": "...", "tags": ["..."]}]；没有就回答 []。',
  '只记下次会话仍然成立的事实（决定、偏好、约定、命名、编号），不要记这次做了什么。',
].join('\n')

export interface MemoryCandidate {
  readonly text: string
  readonly tags: readonly string[]
}

/**
 * 解析模型的回答（**宽松但确定**）：
 * 1. 先剥掉可能的代码围栏，取第一个 [ 到最后一个 ] 之间的内容做 JSON.parse；
 * 2. JSON 解析失败时退化成"一行一条"（去掉项目符号），因为模型偶尔会无视格式要求；
 * 3. 两种路径都过滤空文本与缺 text 的条目 —— 解析器不猜。
 */
export function parseMemoryCandidates(answer: string): MemoryCandidate[] {
  const trimmed = answer.trim()
  const fenced = trimmed.startsWith(FENCE)
    ? trimmed.replace(new RegExp('^' + FENCE + '[a-zA-Z]*\\n'), '').replace(new RegExp('\\n?' + FENCE + '$'), '')
    : trimmed
  const start = fenced.indexOf('[')
  const end = fenced.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(fenced.slice(start, end + 1)) as unknown
      if (Array.isArray(parsed)) {
        return parsed.flatMap(item => {
          if (typeof item !== 'object' || item === null) return []
          const text = (item as { text?: unknown }).text
          if (typeof text !== 'string' || text.trim() === '') return []
          const tags = (item as { tags?: unknown }).tags
          const normalized = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : []
          return [{ text: text.trim(), tags: normalized }]
        })
      }
    } catch {
      // 落到"一行一条"的兜底路径
    }
  }
  return fenced
    .split('\n')
    .map(line => line.replace(/^\s*[-*\d.、)]+\s*/, '').trim())
    .filter(line => line !== '' && line !== '[]' && !line.startsWith(FENCE))
    .map(line => ({ text: line, tags: [EXTRACT_TEMPLATE_V1] }))
}

export interface ExtractOptions {
  readonly store: MemoryStore
  readonly messages: readonly { role: string; content: string }[]
  readonly maxChars?: number
}

export interface ExtractReport {
  readonly candidates: readonly MemoryCandidate[]
  readonly added: readonly MemoryEntry[]
  readonly duplicates: readonly MemoryEntry[]
  /** 有值时表示这次提炼失败（调用方只记日志，不阻断任何东西）。 */
  readonly error?: string
  readonly usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

/**
 * 把候选逐条写进存储（去重由 store 负责），单条失败不影响其余。
 *
 * 单独导出是因为**"谁调模型"有两种合法路径**：`extractMemories` 自己调（离线脚本），
 * 或者调用方让模型在**正常回合**里回答、再由这里只做写入（CLI 走这条 —— 那次请求与回答
 * 因此天然落在会话日志里，不需要内核认识"提炼"这个概念）。
 */
export async function storeCandidates(
  store: MemoryStore,
  candidates: readonly MemoryCandidate[],
): Promise<{ added: MemoryEntry[]; duplicates: MemoryEntry[] }> {
  const added: MemoryEntry[] = []
  const duplicates: MemoryEntry[] = []
  for (const candidate of candidates) {
    try {
      const result = await store.append({
        text: candidate.text,
        tags: candidate.tags.length === 0 ? [EXTRACT_TEMPLATE_V1] : candidate.tags,
      })
      if (result.duplicate) duplicates.push(result.entry)
      else added.push(result.entry)
    } catch {
      // 单条写不进去（空文本等）不该让整次提炼失败
    }
  }
  return { added, duplicates }
}

/** 把会话渲染成提炼输入（有上限：提炼输入不该比会话本身还大）。 */
export function renderExtractionInput(messages: readonly { role: string; content: string }[], maxChars: number): string {
  const rendered = messages.map(message => message.role + ': ' + message.content).join('\n\n')
  return rendered.length <= maxChars ? rendered : '（更早内容已省略）\n' + rendered.slice(rendered.length - maxChars)
}

/**
 * 提炼的核心（S4.5）：调一次模型 → 解析 → 逐条写入（去重由 store 负责）。
 *
 * **它不碰日志**：调用方负责把这次请求与回答记进日志（CLI 走的是"会话末尾的正常回合"，
 * 因此 request/header 与 assistant/message 天然在日志里）。这样内核不需要认识"提炼"这个概念。
 */
export async function extractMemories(
  adapter: LlmAdapter,
  options: ExtractOptions,
): Promise<ExtractReport> {
  const maxChars = options.maxChars ?? 24_000
  const request: LlmRequest = {
    provider: adapter.provider,
    model: adapter.model,
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: renderExtractionInput(options.messages, maxChars) }] }],
  }
  let answer = ''
  let usage: ExtractReport['usage']
  try {
    const controller = new AbortController()
    for await (const chunk of adapter.stream(request, controller.signal)) {
      if (chunk.delta !== undefined) answer += chunk.delta
      if (chunk.usage !== undefined) usage = chunk.usage
    }
  } catch (error) {
    return {
      candidates: [],
      added: [],
      duplicates: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const candidates = parseMemoryCandidates(answer)
  const { added, duplicates } = await storeCandidates(options.store, candidates)
  return {
    candidates,
    added,
    duplicates,
    ...(usage === undefined ? {} : { usage }),
  }
}