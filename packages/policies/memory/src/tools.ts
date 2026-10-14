import type { Tool } from '@cubus/tool-registry'
import type { MemoryEntry } from './store.ts'
import type { MemoryStore } from './store.ts'

export const RECALL_MEMORY_TOOL = 'recall_memory'
export const REMEMBER_MEMORY_TOOL = 'remember_memory'

/** 单次返回的字符上限：回忆不能自己把窗口撑爆（和 read_session_log 同一条纪律）。 */
export const RECALL_MAX_CHARS = 8_000
/** 一次检索最多返回几条。 */
export const RECALL_MAX_ENTRIES = 10

function stringField(args: unknown, name: string): string {
  if (typeof args !== 'object' || args === null || !(name in args)) throw new Error('missing argument: ' + name)
  const value = (args as Record<string, unknown>)[name]
  if (typeof value !== 'string' || value.trim() === '') throw new Error('argument ' + name + ' must be a non-empty string')
  return value
}

function optionalInt(args: unknown, name: string): number | undefined {
  if (typeof args !== 'object' || args === null || !(name in args)) return undefined
  const value = (args as Record<string, unknown>)[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('argument ' + name + ' must be a positive integer')
  }
  return value
}

function optionalStringArray(args: unknown, name: string): string[] | undefined {
  if (typeof args !== 'object' || args === null || !(name in args)) return undefined
  const value = (args as Record<string, unknown>)[name]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error('argument ' + name + ' must be an array of strings')
  }
  return value as string[]
}

function renderEntry(entry: MemoryEntry): string {
  const tags = entry.tags.length === 0 ? '' : ' [' + entry.tags.join(',') + ']'
  const source = entry.source?.sessionId === undefined ? '' : '（来自会话 ' + entry.source.sessionId + '）'
  return '- ' + entry.id + tags + ' ' + entry.at.slice(0, 10) + source + '\n  ' + entry.text.replace(/\n/g, '\n  ')
}

/**
 * `recall_memory`：把索引里只给了一行的记忆**按需读回正文**。
 *
 * 与 MCP 的"先给名字、再取 schema"、压缩的"先给预览、再读回全文"是同一条设计：
 * **索引便宜、正文贵**。两条纪律：输出有上限（单次 8k 字符）、只在**本机记忆文件**里找。
 */
export function createRecallMemoryTool(store: MemoryStore): Tool {
  return {
    name: RECALL_MEMORY_TOOL,
    description:
      'Read the full text of long-term memory entries that the prompt only shows as a one-line index. ' +
      'Pass id for one entry (the index shows ids), or query for keyword search. Output is capped - ' +
      'narrow the query if you need more.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'memory id from the index, e.g. m-2026-10-13-001' },
        query: { type: 'string', description: 'keywords to search memory text and tags' },
        limit: { type: 'integer', description: 'max entries for a query, default 5, capped at 10' },
      },
    },
    async execute(args): Promise<string> {
      const id = typeof args === 'object' && args !== null && 'id' in args ? stringField(args, 'id') : undefined
      if (id !== undefined) {
        const { entries } = await store.list()
        const entry = entries.find(candidate => candidate.id === id)
        if (entry === undefined) {
          const recent = await store.recent(5)
          const hint = recent.length === 0 ? '（记忆目前是空的）' : '最近的条目：' + recent.map(item => item.id).join(', ')
          return '没有 id 为 ' + id + ' 的记忆。' + hint
        }
        return '记忆 ' + entry.id + ' 的正文：\n' + entry.text
      }

      const query = stringField(args, 'query')
      const limit = Math.min(optionalInt(args, 'limit') ?? 5, RECALL_MAX_ENTRIES)
      const hits = await store.search(query, limit)
      if (hits.length === 0) {
        const { entries } = await store.list()
        return '没有匹配 "' + query + '" 的记忆（当前共 ' + String(entries.length) + ' 条）。换个关键词，或先用记忆索引里的 id 精确取回。'
      }
      const header = '按关键词 "' + query + '" 找到 ' + String(hits.length) + ' 条：'
      const body: string[] = []
      let used = 0
      let clipped = 0
      for (const entry of hits) {
        const rendered = renderEntry(entry)
        if (used + rendered.length > RECALL_MAX_CHARS) {
          clipped += 1
          continue
        }
        used += rendered.length
        body.push(rendered)
      }
      const tail = clipped === 0 ? '' : '\n（还有 ' + String(clipped) + ' 条因长度上限未显示，可用更精确的关键词或 id 取回。）'
      return header + '\n' + body.join('\n') + tail
    },
  }
}

/**
 * `remember_memory`：模型显式记下一条长期事实。
 *
 * **写入本身就在日志里**（这次工具调用是一条 `tool/call` + `tool/result`），所以"记了什么、
 * 什么时候记的"可回放；去重由存储负责（重复的返回原 id，不再写盘）。
 */
export function createRememberMemoryTool(store: MemoryStore): Tool {
  return {
    name: REMEMBER_MEMORY_TOOL,
    description:
      'Store one durable fact for future sessions: a decision, a preference, a constraint, or a ' +
      'project-specific convention that the user will expect you to know next time. ' +
      'Do not store transient task state. Duplicates are ignored and the existing id is returned.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'the fact, one or two sentences, self-contained' },
        tags: { type: 'array', items: { type: 'string' }, description: 'optional topic tags, e.g. ["order","决定"]' },
      },
      required: ['text'],
    },
    async execute(args): Promise<string> {
      const text = stringField(args, 'text')
      const tags = optionalStringArray(args, 'tags')
      const result = await store.append({ text, ...(tags === undefined ? {} : { tags }) })
      return result.duplicate
        ? '这条记忆已经存在：' + result.entry.id + '（未重复写入）'
        : '已记住 ' + result.entry.id + '：' + result.entry.text
    },
  }
}
