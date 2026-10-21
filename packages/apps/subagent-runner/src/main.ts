/**
 * 子 Agent 进程入口（S6.2，app 层）。
 *
 * 为什么在 app 层而不是 policy 层：它要装配 **sdk + 具体产品 recipe**，而分层规则禁止
 * policy 依赖 product/sdk（架构守卫会红）。policy 层只负责"定义、worktree、进程管道"，
 * 装配属于 app 的职责。
 *
 * 它做三件事：①用同一条装配路径起一个独立会话；②跑完把结果写成 JSON 契约；③退出。
 * 测试模式：`CUBUS_SUBAGENT_FAKE=1` 时用脚本化模型（不调真模型），用于 CI 验证进程与契约。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createLocalAgentHost } from '@cubus/host-local'
import type { LlmAdapter } from '@cubus/llm'
import { cubusCodingAgentRecipe } from '@cubus/recipe-cubus-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'

interface RunnerArgs {
  readonly agent: string
  readonly task: string
  readonly result: string
}

function parseArgs(argv: readonly string[]): RunnerArgs {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === undefined || !value.startsWith('--')) continue
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw new Error(value + ' requires a value')
    values.set(value.slice(2), next)
    index += 1
  }
  const agent = values.get('agent')
  const task = values.get('task')
  const result = values.get('result')
  if (agent === undefined || task === undefined || result === undefined) {
    throw new Error('runner requires --agent, --task and --result')
  }
  return { agent, task, result }
}

/** 假模型：不调真模型，只验证"进程起得来、会话写得下、契约写得出"。 */
function fakeAdapter(): LlmAdapter {
  return {
    provider: 'fake-subagent',
    model: 'fake',
    async *stream() {
      yield { delta: '子 Agent 干完了（测试模式）' }
      yield { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
    },
  }
}

function writeResult(path: string, result: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n', 'utf8')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const startedAt = Date.now()
  const fake = process.env['CUBUS_SUBAGENT_FAKE'] === '1'
  const sessionsDir = process.env['CUBUS_SUBAGENT_SESSIONS'] ?? join(process.cwd(), '.cubus-subagent-sessions')
  const runtime = new SessionRuntime({
    rootDir: sessionsDir,
    host: withToolApprovalHost(
      createLocalAgentHost({
        adapterFactory: fake ? fakeAdapter : () => { throw new Error('真实模型需要 app 注入适配器（评测里走这条）') },
        workspaceDir: process.cwd(),
      }),
      // 子进程无人值守；权限规则层在 S6.3 接入（与父同一份 .cubus/permissions.json）
      createStaticToolApproval('allow', 'subagent runner'),
    ),
    recipe: cubusCodingAgentRecipe,
    recipeOptions: undefined,
    permissionProfile: 'allow',
    retry: { maxAttempts: 1 },
  })
  const session = await runtime.create()
  try {
    const run = await runtime.run(session.id, args.task)
    const toolCalls = run.turnEvents.filter(event => event.type === 'tool/call').length
    const steps = run.turnEvents.filter(event => event.type === 'step/start').length
    const tokens = run.turnEvents.reduce(
      (sum, event) => sum + (event.type === 'assistant/message' ? event.usage?.totalTokens ?? 0 : 0),
      0,
    )
    writeResult(args.result, {
      ok: true,
      id: 'sa-' + args.agent,
      sessionId: session.id,
      summary: (run.assistantText ?? '').slice(0, 2000),
      changedFiles: [],
      stats: { steps, toolCalls, tokens, ms: Date.now() - startedAt },
      exitCode: 0,
    })
  } catch (error) {
    writeResult(args.result, {
      ok: false,
      id: 'sa-' + args.agent,
      summary: 'subagent failed: ' + (error instanceof Error ? error.message : String(error)),
      changedFiles: [],
      exitCode: 1,
    })
    process.exitCode = 1
  }
}

await main()
