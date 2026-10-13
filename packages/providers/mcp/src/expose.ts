import type { AgentRecipe } from '@cubus/agent-recipe'
import type { Context } from '@cubus/cordis'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import type { Tool } from '@cubus/tool-registry'
import { McpConfigError } from './types.ts'
import type { McpClient } from './types.ts'
import type { McpConnections, McpToolWithServer } from './connect.ts'

/** 两个元工具的名字（产品必须在 manifest.tools 里申报它们，见 docs/design/mcp-seam.md §5）。 */
export const MCP_TOOL_SEARCH = 'tool_search'
export const MCP_TOOL_CALL = 'mcp_call'
/** 动态来源标签：远端工具带它注册，产品用 manifest.toolSources 申报。 */
export const MCP_TOOL_SOURCE = 'mcp'
/** 提示词片段的稳定 id。 */
export const MCP_PROMPT_FRAGMENT = 'mcp/tools'

export const DEFAULT_EAGER_THRESHOLD_PERCENT = 10
/** 拿不到真实 token 数时的估算比例：MCP schema 是 JSON，符号密度高于自然语言。 */
export const CHARS_PER_TOKEN = 2.5
export const MAX_SEARCH_RESULTS = 5

export type McpExposureMode = 'eager' | 'on-demand' | 'native'

/** 远端工具在注册表里的限定名：`<server>__<tool>`（避免与内建工具重名）。 */
export function qualifiedToolName(server: string, tool: string): string {
  return server + '__' + tool
}

export function mcpToolSchemaChars(tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]): number {
  let total = 0
  for (const tool of tools) {
    try {
      total += JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }).length
    } catch {
      total += tool.name.length + tool.description.length
    }
  }
  return total
}

/**
 * 决定工具定义的暴露方式。
 *
 * - 显式配置优先；配 `native` 但 provider 不支持延迟加载 → **报错**（不静默降级成别的模式）；
 * - 缺省按体量：schema 估算 token 低于上下文窗口的 10% 就全量给，否则按需检索。
 */
export function decideExposureMode(options: {
  readonly tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]
  readonly contextWindow: number
  readonly configured?: McpExposureMode
  readonly providerSupportsNative?: boolean
  readonly thresholdPercent?: number
}): McpExposureMode {
  if (options.configured !== undefined) {
    if (options.configured === 'native' && options.providerSupportsNative !== true) {
      throw new McpConfigError('native tool loading requires a provider that supports deferred tool definitions')
    }
    return options.configured
  }
  if (options.tools.length === 0) return 'eager'
  const threshold = (options.contextWindow * (options.thresholdPercent ?? DEFAULT_EAGER_THRESHOLD_PERCENT)) / 100
  return Math.floor(mcpToolSchemaChars(options.tools) / CHARS_PER_TOKEN) < threshold ? 'eager' : 'on-demand'
}

export interface McpExposurePlan {
  readonly mode: McpExposureMode
  /** 计划注册的工具名（on-demand = 两个元工具；eager = 元工具 + 全部远端工具）。 */
  readonly registeredTools: readonly string[]
  /** 按需模式要写进 system prompt 的名字清单文本；eager 模式为空串。 */
  readonly promptText: string
  /** 未加载 schema 的远端工具（限定名），供审计/展示。 */
  readonly deferredTools: readonly string[]
}

/** 纯函数：算出"这次暴露成什么样"，便于单测与装配前预览。 */
export function planMcpExposure(options: {
  readonly tools: readonly McpToolWithServer[]
  readonly mode: McpExposureMode
  readonly maxSearchResults?: number
}): McpExposurePlan {
  const deferred = options.tools.map(tool => qualifiedToolName(tool.server, tool.name))
  if (options.mode === 'eager') {
    return {
      mode: 'eager',
      registeredTools: [MCP_TOOL_CALL, MCP_TOOL_SEARCH, ...deferred],
      promptText: '',
      deferredTools: [],
    }
  }
  return {
    mode: options.mode,
    registeredTools: [MCP_TOOL_CALL, MCP_TOOL_SEARCH],
    promptText: buildPromptSection(options.tools, options.maxSearchResults ?? MAX_SEARCH_RESULTS),
    deferredTools: deferred,
  }
}

/** 清单只写名字与来源：schema 由 tool_search 按需取（省的是这部分）。 */
export function buildPromptSection(
  tools: readonly McpToolWithServer[],
  maxSearchResults: number,
): string {
  if (tools.length === 0) return ''
  const servers = [...new Set(tools.map(tool => tool.server))].sort()
  return [
    '# mcpTools',
    '外部工具（MCP）的 schema 未加载。需要时先用 tool_search 检索：支持关键词，',
    '或用 "select:限定名[,限定名]" 精确取；取到后再用 mcp_call(server, tool, arguments) 调用。',
    '最多一次返回 ' + String(maxSearchResults) + ' 个工具的 schema。',
    'MCP 服务器：' + servers.join(', ') + '（共 ' + String(tools.length) + ' 个工具）',
    ...tools.map(tool => '- ' + qualifiedToolName(tool.server, tool.name)),
  ].join('\n')
}

function stringField(args: unknown, name: string): string {
  if (typeof args !== 'object' || args === null || !(name in args)) throw new Error('missing argument: ' + name)
  const value = (args as Record<string, unknown>)[name]
  if (typeof value !== 'string') throw new Error('argument ' + name + ' must be a string')
  return value
}

function optionalStringField(args: unknown, name: string): string | undefined {
  if (typeof args !== 'object' || args === null || !(name in args)) return undefined
  const value = (args as Record<string, unknown>)[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('argument ' + name + ' must be a string')
  return value
}

/** 检索：`select:` 精确取，否则按名字/描述的关键词匹配。 */
export function searchTools(
  tools: readonly McpToolWithServer[],
  query: string,
  maxResults: number,
): readonly McpToolWithServer[] {
  const trimmed = query.trim()
  if (trimmed.toLowerCase().startsWith('select:')) {
    const wanted = trimmed.slice('select:'.length)
      .split(',')
      .map(name => name.trim())
      .filter(name => name !== '')
    const selected: McpToolWithServer[] = []
    for (const name of wanted) {
      const found = tools.find(tool =>
        qualifiedToolName(tool.server, tool.name) === name || tool.name === name)
      if (found !== undefined && !selected.includes(found)) selected.push(found)
      if (selected.length >= maxResults) break
    }
    return selected
  }
  const needles = trimmed.toLowerCase().split(/\s+/).filter(needle => needle !== '')
  if (needles.length === 0) return []
  const matches = tools.filter(tool => {
    const haystack = (tool.name + ' ' + tool.description + ' ' + tool.server).toLowerCase()
    return needles.every(needle => haystack.includes(needle))
  })
  return matches.slice(0, maxResults)
}

function renderTool(tool: McpToolWithServer): string {
  return [
    qualifiedToolName(tool.server, tool.name),
    '  server: ' + tool.server,
    '  tool: ' + tool.name,
    '  description: ' + tool.description,
    '  input_schema: ' + JSON.stringify(tool.inputSchema),
  ].join('\n')
}

/** `tool_search`：把选中的 schema 作为**工具结果文本**交给模型（于是它自然进了日志）。 */
export function buildToolSearchTool(
  tools: readonly McpToolWithServer[],
  maxResults = MAX_SEARCH_RESULTS,
): Tool {
  return {
    name: MCP_TOOL_SEARCH,
    description:
      'Search the external MCP tools whose schemas are not loaded yet and return the matching schemas. ' +
      'Use a keyword query, or "select:<qualified-name>[,<name>...]" to fetch specific tools by name. ' +
      'Call the returned tools with mcp_call(server, tool, arguments).',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keyword(s), or "select:<qualified-name>[,<name>...]"' },
      },
      required: ['query'],
    },
    execute(args): string {
      if (tools.length === 0) return '没有已连接的 MCP 工具（检查 mcpServers 配置）。'
      const query = stringField(args, 'query')
      const matches = searchTools(tools, query, maxResults)
      if (matches.length === 0) {
        const examples = tools.slice(0, 3).map(tool => qualifiedToolName(tool.server, tool.name))
        return '没有匹配的工具：' + query + '。共 ' + String(tools.length) + ' 个，例如 ' +
          examples.join(', ') + '。可用关键词或 "select:<名字>" 重试。'
      }
      return '匹配 ' + String(matches.length) + ' 个工具（用 mcp_call 调用）：\n\n' +
        matches.map(renderTool).join('\n\n')
    },
  }
}

/** `mcp_call`：统一的调用入口。名字支持限定名、短名（唯一时）与显式 server 参数。 */
export function buildMcpCallTool(
  clients: ReadonlyMap<string, McpClient>,
  tools: readonly McpToolWithServer[],
): Tool {
  return {
    name: MCP_TOOL_CALL,
    description:
      'Invoke a tool on a connected MCP server. Pass the tool name (qualified as "server__tool", ' +
      'or the plain name when it is unique) and its arguments object.',
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'tool name, e.g. "linear__create_issue" or "create_issue"' },
        server: { type: 'string', description: 'optional server name when the tool name is ambiguous' },
        arguments: { type: 'object', description: 'arguments object for the remote tool' },
      },
      required: ['tool'],
    },
    async execute(args, context): Promise<string> {
      context.signal.throwIfAborted()
      const requested = stringField(args, 'tool')
      const serverHint = optionalStringField(args, 'server')
      const rawArguments = typeof args === 'object' && args !== null
        ? (args as Record<string, unknown>).arguments
        : undefined
      if (rawArguments !== undefined && (typeof rawArguments !== 'object' || rawArguments === null || Array.isArray(rawArguments))) {
        throw new Error('argument arguments must be an object')
      }

      let target = tools.find(tool => qualifiedToolName(tool.server, tool.name) === requested)
      if (target === undefined && serverHint !== undefined) {
        target = tools.find(tool => tool.server === serverHint && tool.name === requested)
      }
      if (target === undefined) {
        const shortMatches = tools.filter(tool => tool.name === requested)
        if (shortMatches.length > 1) {
          throw new Error(
            'ambiguous tool name ' + requested + '：出现在 ' +
            shortMatches.map(tool => tool.server).join(', ') + '，请用 server 参数或限定名',
          )
        }
        target = shortMatches[0]
      }
      if (target === undefined) {
        const known = tools.slice(0, 5).map(tool => qualifiedToolName(tool.server, tool.name))
        throw new Error('unknown tool: ' + requested + '（已知例如 ' + known.join(', ') + '；可用 tool_search 检索）')
      }

      const client = clients.get(target.server)
      if (client === undefined) throw new Error('server is not connected: ' + target.server + '（可用 tool_search 查看可用工具）')

      const result = await client.callTool(target.name, (rawArguments ?? {}) as Record<string, unknown>)
      if (result.isError) throw new Error(result.text === '' ? '远端工具返回错误' : result.text)
      return result.text === '' ? '（远端工具没有返回文本内容）' : result.text
    },
  }
}

/**
 * 把暴露计划挂进上下文：提示词片段 + 元工具（按需模式）或元工具 + 远端工具（全量模式）。
 *
 * 两个元工具**任何模式都注册**：模式由 app 按体量决定，而 manifest 是静态的
 * —— 声明面必须与模式无关，否则同一个产品换个项目就要改声明（见设计文档 §5）。
 */
export async function mountMcpExposure(
  ctx: Context,
  plan: McpExposurePlan,
  connections: McpConnections,
): Promise<void> {
  if (plan.promptText !== '') {
    await ctx.plugin(systemPromptContribution({ id: MCP_PROMPT_FRAGMENT, text: plan.promptText }))
  }
  await ctx.plugin(toolContribution(buildToolSearchTool(connections.tools)))
  await ctx.plugin(toolContribution(buildMcpCallTool(connections.clients, connections.tools)))

  if (plan.mode !== 'eager') return
  for (const remote of connections.tools) {
    const client = connections.clients.get(remote.server)
    if (client === undefined) continue
    const tool: Tool = {
      name: qualifiedToolName(remote.server, remote.name),
      description: remote.description,
      parameters: remote.inputSchema,
      async execute(args, context) {
        context.signal.throwIfAborted()
        const result = await client.callTool(
          remote.name,
          (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
        )
        if (result.isError) throw new Error(result.text === '' ? '远端工具返回错误' : result.text)
        return result.text
      },
    }
    await ctx.plugin(toolContribution(tool, { source: MCP_TOOL_SOURCE }))
  }
}

/** 一台 MCP 服务器进装配快照的摘要（**不含凭据**，只写事实）。 */
export interface McpServerSummary {
  readonly name: string
  readonly transport: 'stdio' | 'http'
  readonly connected: boolean
  readonly toolCount: number
  readonly error?: string
}

/** 进 `session/mount.config` 的 MCP 事实：连了哪些服务器、多少工具、用哪种暴露模式。 */
export interface McpRecipeConfig {
  readonly servers: readonly McpServerSummary[]
  readonly mode: McpExposureMode
  /** 未加载 schema 的工具数（按需模式下等于工具总数）。 */
  readonly deferredTools: number
}

/** 装饰后的 Recipe 的装配参数类型（app 传 `{ mcp: buildMcpConfig(...) }`）。 */
export interface McpMountOptions {
  readonly mcp?: McpRecipeConfig
}

export function buildMcpConfig(connections: McpConnections, mode: McpExposureMode): McpRecipeConfig {
  const servers = connections.connections.map(connection => ({
    name: connection.name,
    transport: connection.transport,
    connected: connection.connected,
    toolCount: connection.tools.length,
    ...(connection.error === undefined ? {} : { error: connection.error }),
  }))
  return {
    servers,
    mode,
    deferredTools: mode === 'eager' ? 0 : connections.tools.length,
  }
}

/**
 * 给任意产品 Recipe 接上 MCP 工具来源（app 在装配前调用）。
 *
 * 它做两件事：①**扩声明**（把两个元工具加进 manifest.tools、把 `mcp` 加进 toolSources
 * —— 声明面必须包含运行时可能注册的东西，否则装配期校验会拦下）；②**挂载**（先挂产品，
 * 再挂 MCP 的提示词片段与工具贡献）。
 *
 * 模式与连接由 app 决定：这样"同一个产品在不同项目里连不同服务器"不需要改产品代码，
 * 而"这次连了什么、用了哪种模式"会通过 `recipeOptions.mcp` 进装配快照。
 */
export function withMcpTools(
  recipe: AgentRecipe<void>,
  options: {
    readonly connections: McpConnections
    readonly contextWindow: number
    readonly configured?: McpExposureMode
    readonly providerSupportsNative?: boolean
  },
): AgentRecipe<McpMountOptions> {
  const mode = decideExposureMode({
    tools: options.connections.tools,
    contextWindow: options.contextWindow,
    ...(options.configured === undefined ? {} : { configured: options.configured }),
    ...(options.providerSupportsNative === undefined ? {} : { providerSupportsNative: options.providerSupportsNative }),
  })
  const plan = planMcpExposure({ tools: options.connections.tools, mode })
  const declared = [...new Set([...recipe.manifest.tools, MCP_TOOL_CALL, MCP_TOOL_SEARCH])].sort()
  const sources = [...new Set([...(recipe.manifest.toolSources ?? []), MCP_TOOL_SOURCE])].sort()

  return {
    manifest: {
      ...recipe.manifest,
      tools: declared,
      toolSources: sources,
    },
    async mount(ctx, recipeOptions) {
      // 产品自己的 mount 不关心额外的装配参数（它只读 Host 提供的能力）。
      await recipe.mount(ctx, undefined)
      if (options.connections.tools.length === 0 && options.connections.connections.length === 0) return
      await mountMcpExposure(ctx, plan, options.connections)
      void recipeOptions
    },
  }
}
