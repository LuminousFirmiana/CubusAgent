import type { RegisteredTool, Tool, ToolSource } from './types.ts'

function validateTool(tool: Tool): void {
  if (tool.name.trim() === '') throw new TypeError('tool name must not be empty')
  if (tool.description.trim() === '') throw new TypeError(`tool ${tool.name} description must not be empty`)
  if (typeof tool.parameters !== 'object' || tool.parameters === null || Array.isArray(tool.parameters)) {
    throw new TypeError(`tool ${tool.name} parameters must be an object`)
  }
  if (typeof tool.execute !== 'function') throw new TypeError(`tool ${tool.name} execute must be a function`)
}

/** 注册选项：来源标签缺省表示"产品自带的内建工具"（见 types.ts 的 ToolSource）。 */
export interface ToolRegistrationOptions {
  readonly source?: ToolSource
}

interface Entry {
  readonly tool: Tool
  readonly source?: ToolSource
}

/** Scoped registry whose snapshots are stable for one model/tool step. */
export class ToolRegistryService {
  private readonly tools = new Map<string, Entry>()

  register(tool: Tool, options: ToolRegistrationOptions = {}): () => void {
    validateTool(tool)
    const source = options.source
    if (source !== undefined && source.trim() === '') {
      throw new TypeError(`tool ${tool.name} source must not be empty`)
    }
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
    this.tools.set(tool.name, source === undefined ? { tool } : { tool, source })
    return () => this.tools.delete(tool.name)
  }

  /**
   * 快照按名字排序且冻结。带来源的工具会在快照里多一个 `source` 字段 ——
   * 装配期用它判断"多出来的工具是不是来自已声明的动态来源"。
   */
  snapshot(): readonly RegisteredTool[] {
    const items = [...this.tools.values()].map(entry =>
      entry.source === undefined ? entry.tool : { ...entry.tool, source: entry.source })
    return Object.freeze(items.sort((a, b) => a.name.localeCompare(b.name)))
  }
}
