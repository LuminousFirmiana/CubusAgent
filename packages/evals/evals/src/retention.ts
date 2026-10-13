/**
 * 上下文信息保留评测（S3.4）——简历第 4 条那个数字的来源。
 *
 *   pnpm run eval:retention                        # 默认：8 条事实、窗口 6000
 *   pnpm run eval:retention -- --facts 12 --window 8000
 *
 * 它做什么：
 *   1. 在一条真会话里逐轮"种下"若干事实（每一轮都是普通对话，不是"请背下来"）；
 *   2. 让上下文窗口小到足以触发**压缩**（context/compacted）；
 *   3. 压缩之后逐条提问，按答案里是否包含事实的关键片段判分；
 *   4. 打印保留率，并把本轮结果追加到 EVALS.md（人读）与 evals-retention.json（机器读）。
 *
 * 口径（必须一起说）：
 *   - "保留率"= 压缩后仍能正确回答的事实数 / 总事实数；
 *   - 它衡量的是**摘要 + 保留尾部**能不能撑住事实回忆，不是"日志里还在不在"（日志永远在，且可用
 *     read_session_log 读回 —— 那是另一条路，不在本评测的计分里）；
 *   - 模型、提示词、窗口大小都会影响结果，所以每次运行都把参数写进结果文件。
 */
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withContextCompaction } from '@cubus/context-compaction'
import { createLocalAgentHost } from '@cubus/host-local'
import { cubusCodingAgentRecipe } from '@cubus/recipe-cubus-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import { createAdapterFactory, optionValue, readSettings, repositoryRoot, scriptArgs } from './model.ts'

interface Fact {
  readonly id: string
  /** 种下去的那一轮对话（自然语句，含事实）。 */
  readonly prompt: string
  /** 事后提问。 */
  readonly question: string
  /** 判分用的关键片段（答案里出现即算答对）。 */
  readonly needle: string
}

const FACTS: readonly Fact[] = [
  { id: 'timeout', prompt: '记录一个决定：order 服务的默认超时改成 2500 毫秒，暂时不写进文档。', question: 'order 服务的默认超时是多少毫秒？只回答数字。', needle: '2500' },
  { id: 'codename', prompt: '这轮重构的内部代号是 ALPHA-7，只有我们能看懂。', question: '这轮重构的内部代号是什么？只回答代号。', needle: 'ALPHA-7' },
  { id: 'flag', prompt: '灰度开关叫 enable_new_pricing，默认关闭，别记错了。', question: '灰度开关的名字是什么？只回答名字。', needle: 'enable_new_pricing' },
  { id: 'branch', prompt: '我们这次都在 feature/cart-split 分支上干活。', question: '这次的分支名是什么？只回答分支名。', needle: 'feature/cart-split' },
  { id: 'limit', prompt: '分页上限我定成每页 37 条，比默认值小一点。', question: '分页上限每页多少条？只回答数字。', needle: '37' },
  { id: 'owner', prompt: '这个模块的负责人是林悦，有问题找她。', question: '这个模块的负责人是谁？只回答姓名。', needle: '林悦' },
  { id: 'cache', prompt: '缓存键前缀用 cart:v2:，别再混用 v1 了。', question: '缓存键前缀是什么？只回答前缀。', needle: 'cart:v2:' },
  { id: 'deadline', prompt: '这个改动要在第 42 周之前合掉。', question: '这个改动要在第几周之前合掉？只回答数字。', needle: '42' },
  { id: 'table', prompt: '新表叫 order_events_v3，别写成 v2。', question: '新表叫什么？只回答表名。', needle: 'order_events_v3' },
  { id: 'retry', prompt: '重试次数我定成 4 次，间隔 800 毫秒。', question: '重试次数是几次？只回答数字。', needle: '4' },
  { id: 'colour', prompt: '这条流水线在监控面板上是橙色。', question: '这条流水线在监控面板上是什么颜色？只回答颜色。', needle: '橙' },
  { id: 'alias', prompt: '老接口的别名保留为 /v1/legacy/order。', question: '老接口的别名路径是什么？只回答路径。', needle: '/v1/legacy/order' },
]

/** 给每一轮垫一些无关但真实的上下文，让投影真的长到能触发压缩。 */
function padding(index: number): string {
  return '（本轮附带的背景，供参考）' +
    ('我们最近在整理订单模块的历史实现，涉及若干文件与历史决策，其中大部分与本条记录无关。'.repeat(12)) +
    ' 编号 ' + String(index) + '。'
}

const args = scriptArgs()
const factCount = Number.parseInt(optionValue(args, '--facts') ?? '8', 10)
const contextWindow = Number.parseInt(optionValue(args, '--window') ?? '6000', 10)
const facts = FACTS.slice(0, factCount)

const settings = await readSettings()
if (settings.apiKey === undefined) {
  console.error('DEEPSEEK_API_KEY is required (process environment or repository .env)')
  process.exit(2)
}
const adapterFactory = await createAdapterFactory(settings.apiKey, settings.model)
const root = mkdtempSync(join(tmpdir(), 'cubus-retention-'))

const runtime = new SessionRuntime({
  rootDir: root,
  host: withToolApprovalHost(
    createLocalAgentHost({ adapterFactory, workspaceDir: root }),
    createStaticToolApproval('allow', 'retention eval'),
  ),
  recipe: withContextCompaction(cubusCodingAgentRecipe, { contextWindow }),
  recipeOptions: undefined,
  permissionProfile: 'allow',
  retry: { maxAttempts: 2 },
})
const session = await runtime.create()

// 1) 种事实
for (const [index, fact] of facts.entries()) {
  await runtime.run(session.id, padding(index) + '\n\n' + fact.prompt)
}

// 2) 提问（此时压缩已在若干轮之间发生过）
const answers: { fact: Fact; answer: string; hit: boolean }[] = []
for (const fact of facts) {
  const result = await runtime.run(session.id, fact.question)
  const answer = result.assistantText ?? ''
  answers.push({ fact, answer, hit: answer.includes(fact.needle) })
}

const { events } = await runtime.replay(session.id)
const compactions = events.filter(event => event.type === 'context/compacted')
const kept = answers.filter(entry => entry.hit).length
const retention = Math.round((kept / facts.length) * 1000) / 10

console.log('上下文信息保留评测（压缩之后还能答对多少条事实）')
console.log('  模型 ' + settings.model + ' · 窗口 ' + String(contextWindow) + ' · 事实 ' + String(facts.length) + ' 条')
console.log('  压缩发生 ' + String(compactions.length) + ' 次' +
  (compactions.length === 0 ? '（窗口不够小，没触发 —— 结果不代表压缩后的保留率）' : ''))
for (const entry of answers) {
  console.log('  ' + (entry.hit ? '✓' : '✗') + ' ' + entry.fact.id.padEnd(10) + ' 期望含 "' + entry.fact.needle + '"  实答: ' + entry.answer.replace(/\s+/g, ' ').slice(0, 60))
}
console.log('\n保留率：' + String(kept) + '/' + String(facts.length) + ' = ' + String(retention) + '%')

const record = {
  at: new Date().toISOString(),
  model: settings.model,
  contextWindow,
  facts: facts.length,
  compactions: compactions.length,
  kept,
  retentionPercent: retention,
  missed: answers.filter(entry => !entry.hit).map(entry => entry.fact.id),
}
writeFileSync(join(repositoryRoot, 'packages', 'evals', 'evals', 'evals-retention.json'), JSON.stringify(record, null, 2) + '\n')
appendFileSync(
  join(repositoryRoot, 'packages', 'evals', 'evals', 'EVALS.md'),
  '\n### 上下文信息保留（S3.4）\n\n' +
  '- ' + record.at + ' · ' + record.model + ' · 窗口 ' + String(contextWindow) + ' · 事实 ' + String(facts.length) +
  ' 条 · 压缩 ' + String(compactions.length) + ' 次\n' +
  '- **保留率 ' + String(retention) + '%**（' + String(kept) + '/' + String(facts.length) + '）' +
  (record.missed.length === 0 ? '\n' : '；漏掉：' + record.missed.join(', ') + '\n'),
)
console.log('结果已写入 packages/evals/evals/evals-retention.json 与 EVALS.md')
process.exit(0)
