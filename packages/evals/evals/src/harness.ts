import { createLocalAgentHost } from '@cubus/host-local'
import { SessionRuntime } from '@cubus/sdk'
import type { LlmAdapter } from '@cubus/llm'
import { repairEvalRecipe } from '@cubus/recipe-repair-eval'
import type { SessionEvent } from '@cubus/session'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import { LocalFs, LocalSubprocess } from '@cubus/tools'

export { CODING_AGENT_PROMPT } from '@cubus/recipe-repair-eval'

export interface RepairTaskOptions {
  /** 被修复的仓库目录。 */
  repoDir: string
  /** 会话日志目录（golden trajectory 存档处）。 */
  sessionsDir: string
  /** 适配器工厂：每任务独立实例。 */
  adapterFactory: () => LlmAdapter
  /** 系统提示；默认 CODING_AGENT_PROMPT。 */
  systemPrompt?: string
  /** 判分测试命令；默认 node --test test/。 */
  testCommand?: string
  generateId?: () => string
}

export interface EvalRunResult {
  /** 隐藏测试是否通过（exit 0）。 */
  passed: boolean
  assistantText?: string
  turnEvents: SessionEvent[]
  /** 会话日志路径（golden trajectory）。 */
  logPath: string
  /** 判分测试输出（截尾）。 */
  testOutput: string
}

/**
 * 跑一次修复任务：agent 修复 repoDir 里的失败测试，然后跑测试命令判分。
 * 会话日志全量留存 —— 通过的任务日志即 golden trajectory。
 */
export async function runRepairTask(opts: RepairTaskOptions): Promise<EvalRunResult> {
  const testCommand = opts.testCommand ?? "node --test 'test/*.test.ts'"
  const subprocess = new LocalSubprocess()

  const runtime = new SessionRuntime({
    rootDir: opts.sessionsDir,
    host: withToolApprovalHost(
      createLocalAgentHost({ adapterFactory: opts.adapterFactory }),
      createStaticToolApproval('allow', 'automated repair eval'),
    ),
    recipe: repairEvalRecipe,
    recipeOptions: {
      fs: new LocalFs(opts.repoDir),
      subprocess,
      workspaceDir: opts.repoDir,
      ...(opts.systemPrompt === undefined ? {} : { systemPrompt: opts.systemPrompt }),
    },
    ...(opts.generateId === undefined ? {} : { generateId: opts.generateId }),
  })

  const session = await runtime.create()
  const run = await runtime.run(
    session.id,
    '仓库里的测试失败了。请找到原因并修复代码，让所有测试通过。改完后运行测试确认，然后报告你改了什么。',
  )

  const testResult = await subprocess.run(testCommand, {
    cwd: opts.repoDir,
    signal: new AbortController().signal,
  })
  const passed = testResult.exitCode === 0

  return {
    passed,
    ...(run.assistantText === undefined ? {} : { assistantText: run.assistantText }),
    turnEvents: run.turnEvents,
    logPath: session.logPath,
    testOutput: (testResult.stdout + testResult.stderr).slice(-2000),
  }
}
