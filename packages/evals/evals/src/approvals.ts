/**
 * 审批打扰量化（S5.3）—— "权限规则把 N 次打扰降到 M 次"这个说法的可复现来源。
 *
 *   pnpm run eval:approvals              # 8 个文件的任务，跑两档
 *   pnpm run eval:approvals -- --files 12
 *
 * 两档跑**同一个任务**：
 *   A. 只有档位（ask）：每一次工具调用都要问人；
 *   B. 档位 + 权限规则：规则覆盖到的直接给结论，**不问人**。
 *
 * 量的是**打扰次数** = 交互式审批发出的 requested 事件数（真有人值守时，那就是他要按的次数）。
 * 为了让评测能自动跑完，收到请求就立刻自动批准 —— 但**计数照数**（这就是"打扰"）。
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalAgentHost } from '@cubus/host-local'
import type { LlmAdapter } from '@cubus/llm'
import { cubusCodingAgentRecipe } from '@cubus/recipe-cubus-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import {
  createInteractiveToolApproval,
  createRulesToolApproval,
  parsePermissionRules,
  withToolApprovalHost,
} from '@cubus/tool-approval'
import type { InteractiveApproval, ToolApprovalService } from '@cubus/tool-approval'
import { createAdapterFactory, optionValue, readSettings, repositoryRoot, scriptArgs } from './model.ts'

/** 造一个只有若干小文件的脚手架工作区（任务不要求改对代码，只要求产生很多次工具调用）。 */
function makeWorkspace(files: number): string {
  const root = mkdtempSync(join(tmpdir(), 'cubus-approvals-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  for (let index = 0; index < files; index += 1) {
    writeFileSync(
      join(root, 'src', 'mod' + String(index).padStart(2, '0') + '.ts'),
      'export function f' + String(index) + '(): number { return ' + String(index) + ' }\n',
      'utf8',
    )
  }
  return root
}

interface RunResult {
  readonly prompts: number
  readonly toolCalls: number
  readonly assistantText: string
}

/** 跑一遍任务；两档唯一的差别就是传进来的 approval。 */
async function runOnce(options: {
  readonly workspace: string
  readonly task: string
  /** 真正做决定的服务（B 档是"规则 + 兜底"的组合）。 */
  readonly approval: ToolApprovalService
  /** 计数点：产生 requested 事件的交互式服务（B 档就是规则的兜底）。 */
  readonly events: InteractiveApproval
  readonly adapterFactory: () => LlmAdapter
}): Promise<RunResult> {
  let prompts = 0
  const unsubscribe = options.events.onEvent(event => {
    if (event.type !== 'requested') return
    prompts += 1
    // 立刻自动批准：评测要能无人跑完，但"打扰"照样计数
    options.events.resolve(event.approval.id, 'allow', 'eval auto-approve')
  })
  const runtime = new SessionRuntime({
    rootDir: join(options.workspace, '.sessions'),
    host: withToolApprovalHost(
      createLocalAgentHost({ adapterFactory: options.adapterFactory, workspaceDir: options.workspace }),
      options.approval,
    ),
    recipe: cubusCodingAgentRecipe,
    recipeOptions: undefined,
    permissionProfile: 'ask',
    retry: { maxAttempts: 2 },
  })
  try {
    const session = await runtime.create()
    const run = await runtime.run(session.id, options.task)
    const toolCalls = run.turnEvents.filter(event => event.type === 'tool/call').length
    return { prompts, toolCalls, assistantText: run.assistantText ?? '' }
  } finally {
    unsubscribe()
  }
}

const args = scriptArgs()
const files = Math.max(2, Number.parseInt(optionValue(args, '--files') ?? '8', 10))

const settings = await readSettings()
if (settings.apiKey === undefined) {
  console.error('DEEPSEEK_API_KEY is required (process environment or repository .env)')
  process.exit(2)
}
const adapterFactory = await createAdapterFactory(settings.apiKey, settings.model)

const command = 'ls src | wc -l'
const task = [
  '请对 src 目录下的每个文件做同一件事：',
  '①用 read_file 读一遍；②用 edit_file 在文件末尾追加一行注释 // reviewed。',
  '全部做完后，用一次 bash 执行 ' + command + ' 确认文件数。',
  '最后用一句话汇报你处理了几个文件。',
].join('')

// A 档：只有 ask，没有任何规则 —— 每次工具调用都要问人
const workspaceA = makeWorkspace(files)
const approvalA = createInteractiveToolApproval({ profile: 'ask', timeoutMs: 60_000 })
const resultA = await runOnce({ workspace: workspaceA, task, approval: approvalA, events: approvalA, adapterFactory })

// B 档：同一任务 + 权限规则（读/写/编辑直接放行，bash 只放行查看类命令）
const workspaceB = makeWorkspace(files)
const { rules } = parsePermissionRules({ version: 1, rules: [
  { tool: 'read_*', decision: 'allow', reason: '读操作不需要打扰人' },
  { tool: 'edit_file', decision: 'allow', reason: '改工作区内的文件由任务本身授权' },
  { tool: 'write_file', decision: 'allow', reason: '同上' },
  { tool: 'bash', args: { regex: '^(ls|cat|wc|head|tail|pwd)' }, decision: 'allow', reason: '只读命令白名单' },
] }, 'eval-permissions.json')
const fallbackB = createInteractiveToolApproval({ profile: 'ask', timeoutMs: 60_000 })
const approvalB = createRulesToolApproval({ rules, fallback: fallbackB })
const resultB = await runOnce({ workspace: workspaceB, task, approval: approvalB, events: fallbackB, adapterFactory })

const reduction = resultA.prompts === 0 ? 0 : Math.round((1 - resultB.prompts / resultA.prompts) * 1000) / 10
console.log('审批打扰量化（同一任务，两档对比）')
console.log('  模型 ' + settings.model + ' · 文件 ' + String(files) + ' 个')
console.log('  A 只有档位 ask：工具调用 ' + String(resultA.toolCalls) + ' 次 → 打扰 ' + String(resultA.prompts) + ' 次')
console.log('  B 档位 + 规则：  工具调用 ' + String(resultB.toolCalls) + ' 次 → 打扰 ' + String(resultB.prompts) + ' 次')
console.log('  打扰下降：' + String(reduction) + '%')

const record = {
  at: new Date().toISOString(),
  model: settings.model,
  files,
  withoutRules: { toolCalls: resultA.toolCalls, prompts: resultA.prompts },
  withRules: { toolCalls: resultB.toolCalls, prompts: resultB.prompts },
  promptReductionPercent: reduction,
}
writeFileSync(join(repositoryRoot, 'packages', 'evals', 'evals', 'evals-approvals.json'), JSON.stringify(record, null, 2) + '\n')
appendFileSync(
  join(repositoryRoot, 'packages', 'evals', 'evals', 'EVALS.md'),
  '\n### 审批打扰（S5.3）\n\n' +
  '- ' + record.at + ' · ' + record.model + ' · 文件 ' + String(files) + ' 个\n' +
  '- 只有档位 ask：工具调用 ' + String(resultA.toolCalls) + ' 次 → 打扰 ' + String(resultA.prompts) + ' 次\n' +
  '- 档位 + 权限规则：工具调用 ' + String(resultB.toolCalls) + ' 次 → 打扰 ' + String(resultB.prompts) + ' 次' +
  '（**下降 ' + String(reduction) + '%**）\n',
)
console.log('结果已写入 packages/evals/evals/evals-approvals.json 与 EVALS.md')
process.exit(0)