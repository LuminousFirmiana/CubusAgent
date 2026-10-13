import { appendFile, readFile } from 'node:fs/promises'

/** 一条记忆：**本机文件是唯一真相**，人可以直接编辑这个文件。 */
export interface MemoryEntry {
  /** 稳定、人读得懂的 id：`m-<日期>-<序号>`（能在会话里被引用）。 */
  readonly id: string
  readonly at: string
  readonly tags: readonly string[]
  readonly text: string
  /** 追到"哪次会话的哪个回合说的"（可审计；提炼来的条目也指回来源会话）。 */
  readonly source?: { readonly sessionId?: string; readonly turnId?: string }
}

/** 追加/读取的注入点：本机实现走 node:fs，测试走内存；换 Host 时只换这一层。 */
export interface MemoryIO {
  read(path: string): Promise<string | undefined>
  append(path: string, text: string): Promise<void>
}

/** 本机实现：`~/.cubus/memory/memory.jsonl`（在工作区之外，因此不走 fs 能力）。 */
export function nodeMemoryIO(): MemoryIO {
  return {
    async read(path) {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return undefined
        throw error
      }
    },
    async append(path, text) {
      await appendFile(path, text, 'utf8')
    },
  }
}

export interface MemoryStoreOptions {
  readonly path: string
  readonly io: MemoryIO
  /** 注入时钟（测试用固定时间；id 里的日期来自它）。 */
  readonly now?: () => Date
}

export interface AppendResult {
  readonly entry: MemoryEntry
  /** true 表示这条与已有条目重复，**没有**写文件。 */
  readonly duplicate: boolean
}

/** 规范化文本：去首尾空白、折叠内部空白、小写 —— 只用于去重比较，不改变原文本。 */
export function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function parseLines(content: string | undefined): { entries: MemoryEntry[]; broken: number } {
  if (content === undefined) return { entries: [], broken: 0 }
  const entries: MemoryEntry[] = []
  let broken = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as MemoryEntry
      if (typeof parsed.id !== 'string' || typeof parsed.text !== 'string') throw new Error('shape')
      entries.push({ ...parsed, tags: parsed.tags ?? [] })
    } catch {
      // 人可编辑的文件会写坏：坏行跳过并计数，不让一行毁掉全部记忆
      broken += 1
    }
  }
  return { entries, broken }
}

/**
 * 记忆存储（S4.3）：append-only JSONL。
 *
 * 三条纪律：
 * 1. **文件是唯一真相**：格式就是一行一条 JSON，用户可以直接编辑/删除；
 * 2. **坏行不致命**：解析失败的行走 `brokenLines` 计数，其余照常可用；
 * 3. **去重按规范化文本**：同一件事说两遍只留一条（避免索引被重复条目挤满）。
 */
export class MemoryStore {
  private readonly path: string
  private readonly io: MemoryIO
  private readonly now: () => Date

  constructor(options: MemoryStoreOptions) {
    this.path = options.path
    this.io = options.io
    this.now = options.now ?? (() => new Date())
  }

  get filePath(): string {
    return this.path
  }

  async list(): Promise<{ entries: MemoryEntry[]; brokenLines: number }> {
    const { entries, broken } = parseLines(await this.io.read(this.path))
    return { entries, brokenLines: broken }
  }

  /** 最近 `limit` 条（新的在前）—— 索引注入用的就是这个。 */
  async recent(limit: number): Promise<MemoryEntry[]> {
    const { entries } = await this.list()
    return entries.slice(-Math.max(0, limit)).reverse()
  }

  /**
   * 追加一条（重复则不写）。id 由"当天已有条目的最大序号 + 1"推出 —— 确定性、可读、不冲突。
   */
  async append(entry: { text: string; tags?: readonly string[]; source?: MemoryEntry['source']; at?: string }): Promise<AppendResult> {
    const text = entry.text.trim()
    if (text === '') throw new Error('memory text must not be empty')
    const { entries } = await this.list()
    const normalized = normalizeMemoryText(text)
    const existing = entries.find(candidate => normalizeMemoryText(candidate.text) === normalized)
    if (existing !== undefined) return { entry: existing, duplicate: true }

    const at = entry.at ?? this.now().toISOString()
    const day = at.slice(0, 10)
    const prefix = 'm-' + day + '-'
    const maxSeq = entries
      .filter(candidate => candidate.id.startsWith(prefix))
      .map(candidate => Number.parseInt(candidate.id.slice(prefix.length), 10))
      .filter(sequence => Number.isInteger(sequence))
      .reduce((max, sequence) => Math.max(max, sequence), 0)
    const created: MemoryEntry = {
      id: prefix + String(maxSeq + 1).padStart(3, '0'),
      at,
      tags: entry.tags ?? [],
      text,
      ...(entry.source === undefined ? {} : { source: entry.source }),
    }
    await this.io.append(this.path, JSON.stringify(created) + '\n')
    return { entry: created, duplicate: false }
  }

  /**
   * 关键词检索（S4.4 的 `recall_memory` 用它）：按"命中词数 → 新的在前"排序。
   * 刻意就是关键词 —— 设计里写清了不是 RAG（没有向量、没有 embedding）。
   */
  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    const terms = normalizeMemoryText(query).split(' ').filter(term => term !== '')
    const { entries } = await this.list()
    const scored = entries.map(entry => {
      const haystack = normalizeMemoryText(entry.text + ' ' + entry.tags.join(' ') + ' ' + entry.id)
      const hits = terms.filter(term => haystack.includes(term)).length
      return { entry, hits }
    }).filter(item => item.hits > 0)
    scored.sort((left, right) => right.hits - left.hits || right.entry.at.localeCompare(left.entry.at))
    return scored.slice(0, Math.max(0, limit)).map(item => item.entry)
  }
}

export interface RenderMemoryIndexOptions {
  /** 索引最多几条（默认 12）。 */
  readonly limit?: number
  /** 单行文本上限（默认 120 字符）。 */
  readonly maxLineChars?: number
}

export const DEFAULT_MEMORY_INDEX_LIMIT = 12
export const DEFAULT_MEMORY_LINE_CHARS = 120

/**
 * 渲染注入用的**索引**（一行一条）。正文不进去 —— 和 MCP 同一个结论：名字便宜、正文贵。
 * 没有条目时返回 undefined（调用方据此不注册片段，保持提示词干净）。
 */
export function renderMemoryIndex(entries: readonly MemoryEntry[], options: RenderMemoryIndexOptions = {}): string | undefined {
  if (entries.length === 0) return undefined
  const limit = options.limit ?? DEFAULT_MEMORY_INDEX_LIMIT
  const maxLineChars = options.maxLineChars ?? DEFAULT_MEMORY_LINE_CHARS
  const lines = entries.slice(0, limit).map(entry => {
    const text = entry.text.replace(/\s+/g, ' ')
    const clipped = text.length > maxLineChars ? text.slice(0, maxLineChars) + '…' : text
    const tags = entry.tags.length === 0 ? '' : ' [' + entry.tags.join(',') + ']'
    return '- ' + entry.id + tags + ' ' + clipped
  })
  return [
    '## 长期记忆（索引）',
    '',
    '以下是跨会话记住的条目（只有索引，正文按需取回）。需要细节时用 recall_memory：',
    '按 id 取单条，或按关键词检索。',
    '',
    ...lines,
  ].join('\n')
}
