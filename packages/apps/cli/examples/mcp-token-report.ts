#!/usr/bin/env node
/**
 * S2.5：同一任务在**两档 MCP 暴露模式**下的真实 token 对比。
 *
 *   pnpm run mcp:tokens                        # 默认 40 个 MCP 工具，两档各跑一次
 *   pnpm run mcp:tokens -- --tools 120         # 造更多工具
 *   pnpm run mcp:tokens -- --task "..."        # 换任务（默认是一个不需要工具的任务）
 *   pnpm run mcp:tokens -- --json              # 机器可读输出
 *
 * 结论从**日志**里取，不用估算：
 *   - request/header.tools  —— 每次请求实际带了多少工具定义、共多少字符；
 *   - assistant/message.usage.promptTokens —— provider 真实回报的 prompt token。
 *
 * 口径必须说清：本脚本只能证明"工具定义本身的固定开销"差多少（默认任务不调用工具）。
 * 按需模式在真正调用工具时还要多付"取回 schema"的那一次（tool_search 的结果文本），
 * 取多了可能反超全量 —— 边界结论见脚本末尾打印的说明与 docs/design/mcp-seam.md §7。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialsError, LocalCredentials } from '@cubus/credentials'
import { createLocalAgentHost } from '@cubus/host-local'
import {
  buildMcpConfig,
  connectMcpServers,
  mcpToolSchemaChars,
  withMcpTools,
} from '@cubus/mcp'
import { createDeepSeekAdapterFactory, MODEL_CREDENTIAL_NAME, readDeepSeekEnvironment } from '@cubus/llm-deepseek'
import { cubusCodingAgentRecipe } from '@cubus/recipe-cubus-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import type { SessionEvent } from '@cubus/session'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import { defaultEnvFile } from '../src/config.ts'

const argv = process.argv.slice(2)
const argOf = (flag: string, fallback: string): string => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : fallback
}
const has = (flag: string): boolean => argv.includes(flag)

const toolCount = Number.parseInt(argOf('--tools', '40'), 10)
const contextWindow = Number.parseInt(argOf('--context', '128000'), 10)
const task = argOf('--task', '只回答一个词：ok')
const asJson = has('--json')
// 假 MCP 服务器住在 @cubus/mcp 包里：测试、工作台演示与本脚本共用同一份。
const fixture = join(import.meta.dirname, '..', '..', '..', 'providers', 'mcp', 'fixtures', 'mcp-echo-server.mjs')

interface RequestRow {
  readonly step: number
  readonly tools: number
  readonly toolChars: number
  readonly promptTokens?: number
  readonly completionTokens?: number
}

interface ModeReport {
  readonly mode: 'eager' | 'on-demand'
  readonly session: string
  readonly requests: readonly RequestRow[]
  readonly toolSearchCalls: number
  readonly mcpCallCalls: number
  /** 首次请求的 promptTokens：这就是"工具定义固定开销"的直接读数。 */
  readonly firstPromptTokens?: number
  readonly totalPromptTokens: number
}

const credentials = new LocalCredentials({ sources: { [MODEL_CREDENTIAL_NAME]: () => credential } })
let credential: string | undefined
const settings = await readDeepSeekEnvironment(process.env, defaultEnvFile())
credential = settings.DEEPSEEK_API_KEY
let adapterFactory: Awaited<ReturnType<typeof createDeepSeekAdapterFactory>>
try {
  adapterFactory = await createDeepSeekAdapterFactory({ credentials, settings })
} catch (error) {
  if (error instanceof CredentialsError) {
    process.stderr.write('需要 DEEPSEEK_API_KEY（环境变量或仓库 .env）\n')
    process.exit(2)
  }
  throw error
}

const connections = await connectMcpServers([
  { name: 'bench', command: process.execPath, args: [fixture, '--tools', String(toolCount), '--name', 'bench-mcp'] },
])
const schemaChars = mcpToolSchemaChars(connections.tools)
const root = await mkdtemp(join(tmpdir(), 'cubus-mcp-tokens-'))

const reports: ModeReport[] = []
try {
  for (const mode of ['eager', 'on-demand'] as const) {
    const runtime = new SessionRuntime({
      rootDir: root,
      host: withToolApprovalHost(
        createLocalAgentHost({ adapterFactory, workspaceDir: process.cwd(), credentials }),
        createStaticToolApproval('allow', 'mcp token report'),
      ),
      recipe: withMcpTools(cubusCodingAgentRecipe, {
        connections,
        contextWindow,
        configured: mode,
      }),
      recipeOptions: { mcp: buildMcpConfig(connections, mode) },
      permissionProfile: 'allow',
      retry: { maxAttempts: 2 },
    })
    const session = await runtime.create()
    await runtime.run(session.id, task)
    const { events } = await runtime.replay(session.id)
    reports.push(summarize(mode, session.id, events))
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ toolCount, schemaChars, contextWindow, reports }, null, 2) + '\n')
  } else {
    print(reports, schemaChars, contextWindow)
  }
} finally {
  await connections.close()
  await rm(root, { recursive: true, force: true })
}

function summarize(mode: 'eager' | 'on-demand', session: string, events: readonly SessionEvent[]): ModeReport {
  const requests: RequestRow[] = []
  let step = 0
  let toolSearchCalls = 0
  let mcpCallCalls = 0
  for (const event of events) {
    if (event.type === 'step/start') step += 1
    if (event.type === 'tool/call') {
      if (event.name === 'tool_search') toolSearchCalls += 1
      if (event.name === 'mcp_call') mcpCallCalls += 1
    }
    if (event.type === 'request/header') {
      const tools = event.header.tools ?? []
      requests.push({
        step,
        tools: tools.length,
        toolChars: JSON.stringify(tools).length,
      })
    }
    if (event.type === 'assistant/message' && event.usage !== undefined) {
      const last = requests[requests.length - 1]
      if (last !== undefined) {
        requests[requests.length - 1] = {
          ...last,
          promptTokens: event.usage.promptTokens,
          completionTokens: event.usage.completionTokens,
        }
      }
    }
  }
  const first = requests.find(request => request.promptTokens !== undefined)
  return {
    mode,
    session,
    requests,
    toolSearchCalls,
    mcpCallCalls,
    ...(first?.promptTokens === undefined ? {} : { firstPromptTokens: first.promptTokens }),
    totalPromptTokens: requests.reduce((sum, request) => sum + (request.promptTokens ?? 0), 0),
  }
}

function print(reports: readonly ModeReport[], schemaChars: number, contextWindow: number): void {
  const estimate = (chars: number): number => Math.floor(chars / 2.5)
  process.stdout.write('MCP 工具来源 token 对比（真实 provider 计数，任务：' + task + '）\n')
  process.stdout.write('  工具 ' + String(toolCount) + ' 个 / schema ' + String(schemaChars) + ' 字符' +
    '（估算 ' + String(estimate(schemaChars)) + ' token，仅作量级参照）\n')
  process.stdout.write('  上下文窗口 ' + String(contextWindow) + ' / 阈值 10% = ' + String(Math.floor(contextWindow * 0.1)) + ' token\n\n')
  for (const report of reports) {
    process.stdout.write('[' + report.mode + ']  会话 ' + report.session.slice(0, 8) +
      '  tool_search ' + String(report.toolSearchCalls) + ' 次 / mcp_call ' + String(report.mcpCallCalls) + ' 次\n')
    for (const request of report.requests) {
      process.stdout.write('   step ' + String(request.step) +
        '  工具 ' + String(request.tools) + ' 个（' + String(request.toolChars) + ' 字符）' +
        '  prompt ' + String(request.promptTokens ?? '?') +
        '  completion ' + String(request.completionTokens ?? '?') + '\n')
    }
    process.stdout.write('   首次请求 prompt：' + String(report.firstPromptTokens ?? '?') +
      '  全部请求 prompt 合计：' + String(report.totalPromptTokens) + '\n\n')
  }
  const eager = reports.find(report => report.mode === 'eager')
  const onDemand = reports.find(report => report.mode === 'on-demand')
  if (eager?.firstPromptTokens !== undefined && onDemand?.firstPromptTokens !== undefined) {
    const saved = eager.firstPromptTokens - onDemand.firstPromptTokens
    const percent = ((saved / eager.firstPromptTokens) * 100).toFixed(1)
    process.stdout.write('首次请求省下：' + String(saved) + ' token（-' + percent + '%）\n')
    process.stdout.write('全部请求省下：' + String(eager.totalPromptTokens - onDemand.totalPromptTokens) + ' token\n')
  }
  // 边界说明按**本次实测**写，不写死：调没调工具、取回 schema 的代价多少，都是数据。
  const retrieval = onDemand !== undefined && onDemand.toolSearchCalls > 0
    ? onDemand.requests[1]?.promptTokens !== undefined && onDemand.requests[0]?.promptTokens !== undefined
      ? '（本次实测：检索那一步 prompt +' +
        String(onDemand.requests[1].promptTokens - onDemand.requests[0].promptTokens) + ' token）'
      : '（本次有检索，但步数不足，未测到差值）'
    : '（本次没有检索，差额就是工具定义的固定开销）'
  process.stdout.write(
    '\n边界（必读）：\n' +
    '  ① 按需模式真正取用工具时要多付"取回 schema"的代价：' + retrieval + '；取回越多越接近全量，\n' +
    '     全部取回后反而比全量更贵（schema 会以文本形式再进一次上下文）。\n' +
    '  ② native（provider 侧延迟）不在本次对比内 —— 当前适配器不支持，配了会直接报错而非静默降级。\n' +
    '  ③ 结论一律以真实 promptTokens 为准：字符数 ÷ 2.5 的估算会**高估**（本次 ' + String(toolCount) + ' 工具估算 ' +
    String(Math.floor(schemaChars / 2.5)) + '，实测全量首请求 ' + String(eager?.firstPromptTokens ?? '?') + '），\n' +
    '     差在 JSON 的 token 密度上（估算公式按 2.5 字符/token，实际接近 4）。\n',
  )
}
