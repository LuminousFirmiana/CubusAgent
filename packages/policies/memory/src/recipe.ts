import type { AgentRecipe } from '@cubus/agent-recipe'
import type { Context } from '@cubus/cordis'
import { renderMemoryIndex } from './store.ts'
import type { MemoryStore } from './store.ts'
import { createRecallMemoryTool, createRememberMemoryTool, RECALL_MEMORY_TOOL, REMEMBER_MEMORY_TOOL } from './tools.ts'

/** 记忆索引在系统提示里的位置：角色 0 → 用户 100 → 项目 200 → **记忆 300**。 */
export const MEMORY_INDEX_ORDER = 300

/** 进装配快照的记忆事实（app 传；不含正文，正文在快照的指令层里另有位置）。 */
export interface MemorySnapshotFacts {
  readonly path: string
  readonly entries: number
  readonly indexLimit: number
}

export interface MemoryMountOptions {
  readonly memory?: MemorySnapshotFacts
}

declare module '@cubus/cordis' {
  interface Context {
    /** 本机记忆存储：供 recall/remember 工具与后台提炼使用。 */
    memoryStore: MemoryStore
  }
}

export interface MemoryPluginConfig {
  readonly store: MemoryStore
  readonly indexLimit?: number
  readonly maxLineChars?: number
}

/**
 * 记忆插件（S4.3）：把 `memoryStore` 挂成服务，并把**索引**注入系统提示。
 *
 * - 索引只读最近 N 条（默认 12），正文留给 `recall_memory`（S4.4）；
 * - **没有条目时不注册片段**：提示词里不出现空标题；
 * - 存储路径由 app 决定（`~/.cubus/memory/memory.jsonl`），本机文件是唯一真相。
 */
export const memoryPlugin = {
  name: 'memory',
  inject: ['systemPrompt', 'tools'],
  async apply(ctx: Context, config: MemoryPluginConfig) {
    const { entries, brokenLines } = await config.store.list()
    ctx.provide('memoryStore', config.store)
    // 工具与索引一起挂：模型先看索引知道"有什么"，再用 recall 取正文
    ctx.tools.register(createRecallMemoryTool(config.store))
    ctx.tools.register(createRememberMemoryTool(config.store))
    const index = renderMemoryIndex(entries.slice(-(config.indexLimit ?? 12)).reverse(), {
      limit: config.indexLimit ?? 12,
      ...(config.maxLineChars === undefined ? {} : { maxLineChars: config.maxLineChars }),
    })
    if (index === undefined) return
    const notice = brokenLines === 0 ? '' : '\n\n（记忆文件里有 ' + String(brokenLines) + ' 行无法解析，已跳过。）'
    ctx.systemPrompt.register({ id: 'memory.index', order: MEMORY_INDEX_ORDER, text: index + notice })
  },
}

/**
 * 给产品挂上记忆（S4.3）。
 *
 * 与指令层同一条分工：**app 造 store（它知道路径与本机 IO），插件只渲染与提供服务**。
 * 装饰器放在最外层：它要读 app 传进来的 `recipeOptions.memory`（进快照的那份事实）。
 */
export function withMemory<O extends object>(
  recipe: AgentRecipe<O>,
  config: MemoryPluginConfig,
): AgentRecipe<O & MemoryMountOptions>
export function withMemory(
  recipe: AgentRecipe<void>,
  config: MemoryPluginConfig,
): AgentRecipe<MemoryMountOptions>
export function withMemory(
  recipe: AgentRecipe<object> | AgentRecipe<void>,
  config: MemoryPluginConfig,
): AgentRecipe<MemoryMountOptions> {
  const inner = recipe as AgentRecipe<object>
  // 扩声明：工具注册进注册表，声明面必须同时列出它们（否则装配期校验拦下）
  const declared = [...new Set([...recipe.manifest.tools, RECALL_MEMORY_TOOL, REMEMBER_MEMORY_TOOL])].sort()
  return {
    manifest: { ...recipe.manifest, tools: declared },
    async mount(ctx: Context, options: MemoryMountOptions) {
      await inner.mount(ctx, options)
      await ctx.plugin(memoryPlugin, config)
    },
  }
}