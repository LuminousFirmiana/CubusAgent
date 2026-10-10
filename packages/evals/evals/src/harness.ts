import { GitCliWorkspaceProvider } from '@cubus/git-cli'
import type { GitChangeReport } from '@cubus/git'
import { createLocalAgentHost } from '@cubus/host-local'
import { SessionRuntime } from '@cubus/sdk'
import type { BudgetLimits, BudgetTripReason } from '@cubus/sdk'
import type { LlmAdapter } from '@cubus/llm'
import { repairEvalRecipe, REPAIR_EVAL_SUITE } from '@cubus/recipe-repair-eval'
import type { SessionEvent } from '@cubus/session'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import { LocalSubprocess } from '@cubus/tools'
import { behaviorFingerprint } from './fingerprint.ts'
import type { BehaviorFingerprint } from './fingerprint.ts'
import { assertSuiteRegistered } from './suites.ts'

export { CODING_AGENT_PROMPT } from '@cubus/recipe-repair-eval'
export { REPAIR_EVAL_SUITE } from '@cubus/recipe-repair-eval'

export interface RepairTaskOptions {
  /** 被修复的仓库目录（同时是 Host 的工作区：fs 的根与 bash 的 cwd）。 */
  repoDir: string
  /** 会话日志目录（golden trajectory 存档处）。 */
  sessionsDir: string
  /** 适配器工厂：每任务独立实例。 */
  adapterFactory: () => LlmAdapter
  /** 判分测试命令；默认 node --test test/。 */
  testCommand?: string
  /** app 级预算覆盖（默认取 recipe manifest 的预算：40 步 / 60 工具 / 10 分钟 / 200k token）。 */
  budget?: BudgetLimits
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
  /** 工作区变更（A1 只读 Git 报告）：行为指纹的文件集来源。 */
  changes: GitChangeReport
  /**
   * 被预算拦住的原因（若有）。
   *
   * 与"答错了"必须区分：预算拦住说明任务**跑飞了**（或上限太紧），
   * 而不是模型修得不对 —— 两者在分数表里要能一眼看出。
   */
  budgetTripped?: BudgetTripReason
  /** 行为指纹（D4）：回归门禁的比较对象。 */
  fingerprint: BehaviorFingerprint
}

/** 让夹具副本成为可提交的 git 仓库（指纹需要文件集；重复调用是幂等的）。 */
async function gitInit(repoDir: string, subprocess: LocalSubprocess): Promise<void> {
  const signal = new AbortController().signal
  const run = (command: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> =>
    subprocess.run(command, { cwd: repoDir, signal })
  // 幂等：已经是仓库就直接返回
  const probe = await run('git rev-parse --git-dir')
  if (probe.exitCode === 0) return
  await run('git init -q -b main')
  await run('git config user.email eval@cubus.local')
  await run('git config user.name cubus-eval')
  await run('git add -A')
  await run('git commit -q -m fixture')
}

/**
 * 跑一次修复任务：agent 修复 repoDir 里的失败测试，然后跑测试命令判分。
 * 会话日志全量留存 —— 通过的任务日志即 golden trajectory。
 *
 * 声明校验（B4）：本 harness 只给声明了 repair-eval 套件的 recipe 计分；
 * 声明与计分套件不一致直接失败，避免"拿 A 套件给 B 产品打分"。
 */
export async function runRepairTask(opts: RepairTaskOptions): Promise<EvalRunResult> {
  // 套件校验（D2）：recipe 声明的 suite 必须真实注册，且必须是 harness 计分的那一套。
  // 这一步不可绕过 —— 它保证"拿 A 套件给 B 产品打分"这类错配在评测运行时就失败。
  const declaredSuite = repairEvalRecipe.manifest.evaluation?.suite
  await assertSuiteRegistered(repairEvalRecipe.manifest.id, declaredSuite)
  if (declaredSuite !== REPAIR_EVAL_SUITE) {
    throw new Error(
      'repair-eval recipe declares suite ' + String(declaredSuite) + ' but the harness scores ' + REPAIR_EVAL_SUITE,
    )
  }

  const testCommand = opts.testCommand ?? "node --test 'test/*.test.ts'"
  const subprocess = new LocalSubprocess()

  // 夹具副本变成真实 git 仓库：行为指纹要读工作区文件集（走 A1 的只读 Git provider，
  // 而不是另写一个目录比对器）。基线在运行前记录，因此不要求副本干净。
  await gitInit(opts.repoDir, subprocess)
  const git = new GitCliWorkspaceProvider(subprocess)
  const baseline = await git.baseline(opts.repoDir)

  const runtime = new SessionRuntime({
    rootDir: opts.sessionsDir,
    host: withToolApprovalHost(
      createLocalAgentHost({ adapterFactory: opts.adapterFactory, workspaceDir: opts.repoDir }),
      createStaticToolApproval('allow', 'automated repair eval'),
    ),
    recipe: repairEvalRecipe,
    recipeOptions: undefined,
    // 评测是 app：它把 manifest 的默认档覆盖为 allow，快照会记录 source: app。
    permissionProfile: 'allow',
    // 重试由循环做（F4b）：评测也能从日志里看到重试次数
    retry: { maxAttempts: 3 },
    // 预算：默认取 manifest 声明（评测同样不该跑飞）；app 可覆盖（测试用紧上限）
    ...(opts.budget === undefined ? {} : { budget: opts.budget }),
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
  const changes = await git.report(opts.repoDir, baseline)
  const tripped = runtime.budgetState(session.id)?.tripped

  return {
    passed,
    changes,
    ...(tripped === undefined ? {} : { budgetTripped: tripped }),
    fingerprint: behaviorFingerprint({
      events: run.turnEvents,
      judge: passed ? 'pass' : 'fail',
      changes,
    }),
    ...(run.assistantText === undefined ? {} : { assistantText: run.assistantText }),
    turnEvents: run.turnEvents,
    logPath: session.logPath,
    testOutput: (testResult.stdout + testResult.stderr).slice(-2000),
  }
}
