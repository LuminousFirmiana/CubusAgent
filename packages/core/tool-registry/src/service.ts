import type { Tool } from './types.ts'

function validateTool(tool: Tool): void {
  if (tool.name.trim() === '') throw new TypeError('tool name must not be empty')
  if (tool.description.trim() === '') throw new TypeError(`tool ${tool.name} description must not be empty`)
  if (typeof tool.parameters !== 'object' || tool.parameters === null || Array.isArray(tool.parameters)) {
    throw new TypeError(`tool ${tool.name} parameters must be an object`)
  }
  if (typeof tool.execute !== 'function') throw new TypeError(`tool ${tool.name} execute must be a function`)
}

/** Scoped registry whose snapshots are stable for one model/tool step. */
export class ToolRegistryService {
  private readonly tools = new Map<string, Tool>()

  register(tool: Tool): () => void {
    validateTool(tool)
    if (this.tools.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool)
    return () => this.tools.delete(tool.name)
  }

  snapshot(): readonly Tool[] {
    return Object.freeze([...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name)))
  }
}
