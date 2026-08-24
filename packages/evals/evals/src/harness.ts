import { SessionRuntime } from '@cubus/sdk'
import type { LlmAdapter } from '@cubus/llm'
import type { SessionEvent } from '@cubus/session'
import { createTools, LocalFs, LocalSubprocess } from '@cubus/tools'

/** 编码 agent 的系统提示（v1 文案，随评测迭代）。 */
export const CODING_AGENT_PROMPT = [
  '你是一个修 bug 的编码 agent。',
  '可用工具：read_file（读文件）、edit_file（字符串替换编辑）、write_file（整写）、bash（跑命令）。',
  '任务：找到测试失败的原因，修改代码修复，然后用 bash 跑测试确认全部通过。',
  'edit_file 要求 old_string 在文件中唯一出现；失败时带着更多上下文重试。',
  '完成后用一句话报告你改了什么。',
].join('\n')

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
  const tools = createTools(new LocalFs(opts.repoDir), new LocalSubprocess(), opts.repoDir)

  const runtime = new SessionRuntime({
    rootDir: opts.sessionsDir,
    adapterFactory: opts.adapterFactory,
    tools,
    ...(opts.systemPrompt === undefined ? {} : { systemPrompt: opts.systemPrompt }),
    ...(opts.generateId === undefined ? {} : { generateId: opts.generateId }),
  })

  const session = await runtime.create()
  const run = await runtime.run(
    session.id,
    '仓库里的测试失败了。请找到原因并修复代码，让所有测试通过。改完后运行测试确认，然后报告你改了什么。',
  )

  const testResult = await new LocalSubprocess().run(testCommand, { cwd: opts.repoDir })
  const passed = testResult.exitCode === 0

  return {
    passed,
    ...(run.assistantText === undefined ? {} : { assistantText: run.assistantText }),
    turnEvents: run.turnEvents,
    logPath: session.logPath,
    testOutput: (testResult.stdout + testResult.stderr).slice(-2000),
  }
}
