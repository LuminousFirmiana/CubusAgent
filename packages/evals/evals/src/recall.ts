/**
 * 跨会话召回评测（S4.6）—— 简历里"跨会话记忆"那个数字的来源。
 *
 *   pnpm run eval:recall                 # 默认：4 条可进索引 + 1 条超出索引 + 2 条不该记
 *   pnpm run eval:recall -- --sessions 3 # 跑多轮取平均（每轮独立记忆文件）
 *
 * 它做什么：
 *   1. **会话 A** 逐轮"种下"若干事实（决定/偏好/约定），其中一条的正文**超出索引行长度**；
 *      另外两条是**临时任务状态**（正确行为是**不要**记住它们）；
 *   2. 会话 A 结束后走一个提炼回合（与 CLI 的 --extract-memory 同一套：维护指令 + 解析 + 去重落盘）；
 *   3. **会话 B**（全新会话、同一份记忆文件）逐条提问；
 *   4. 判分并打印：**召回率**（事实题答对比例）、**克制率**（临时状态没被记住的比例）、
 *      以及 **recall_memory 工具被调用了几次**。
 *
 * 口径（必须一起说）：
 *   - 召回率衡量的是"索引 + 按需检索"这条路在**新会话**里能不能答出旧会话的事实；
 *   - 克制率衡量的是**有没有记太多**（把临时状态也记进长期记忆是另一种失败）；
 *   - 只覆盖"短事实"，长文里的事实与多跳问题还没测。
 */
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withContextCompaction } from '@cubus/context-compaction'
import {
  DEFAULT_MEMORY_INDEX_LIMIT,
  EXTRACT_INSTRUCTION,
  MemoryStore,
  nodeMemoryIO,
  parseMemoryCandidates,
  storeCandidates,
  withMemory,
} from '@cubus/memory'
import { createLocalAgentHost } from '@cubus/host-local'
import { cubusCodingAgentRecipe } from '@cubus/recipe-cubus-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import { createAdapterFactory, readSettings, repositoryRoot, scriptArgs, optionValue } from './model.ts'

interface Fact {
  readonly id: string
  /** 会话 A 里种下它的说法。 */
  readonly statement: string
  /** 会话 B 里的提问。 */
  readonly question: string
  /** 判分片段（答案里出现即命中）。 */
  readonly needle: string
  /** 'durable' 应当记住；'transient' 正确行为是**不**记住。 */
  readonly kind: 'durable' | 'transient'
}

const LONG_RATIONALE = '决策背景：'.repeat(2) + '我们在压测里发现默认超时太长会让重试叠加，'.repeat(8)

/**
 * 24 条**同等独特**的错误码映射（约 700 字符）：任何摘要都会有损，只能读回正文 ——
 * 这一条是专门用来把 recall_memory 这条路逼出来的（第一版用"100 步进的规律表"，
 * 提炼模型一眼看出规律、压成一句话就进了索引，检索次数是 0）。
 */
const ERROR_MAP: readonly (readonly [string, string])[] = [
  ['E4201', '登录态已过期'], ['E4202', '余额不足'], ['E4203', '账单周期冲突'],
  ['E4204', '优惠券已核销'], ['E4205', '收货地址不可达'], ['E4206', '库存锁定超时'],
  ['E4207', '支付渠道维护中'], ['E4208', '实名信息不匹配'], ['E4209', '发票抬头缺失'],
  ['E4210', '订单已过取消期'], ['E4211', '账号被风控拦截'], ['E4212', '商品已下架'],
  ['E4213', '限购数量超限'], ['E4214', '配送范围外'], ['E4215', '积分不足抵扣'],
  ['E4216', '合约已终止'], ['E4217', '退款批次冲突'], ['E4218', '对账日不可提现'],
  ['E4219', '会员等级不满足'], ['E4220', '试用期已结束'], ['E4221', '参数签名不合法'],
  ['E4222', '重复提交'], ['E4223', '上游超时'], ['E4224', '服务已降级'],
]

const FACTS: readonly Fact[] = [
  { id: 'timeout', kind: 'durable', statement: '记一个决定：订单服务默认超时改成 2500 毫秒。', question: '订单服务的默认超时是多少毫秒？只回答数字。', needle: '2500' },
  { id: 'flag', kind: 'durable', statement: '灰度开关的名字定成 enable_new_pricing，默认关闭。', question: '灰度开关叫什么名字？只回答名字。', needle: 'enable_new_pricing' },
  { id: 'window', kind: 'durable', statement: '发布窗口固定在每周四下午，周一不发版。', question: '发布窗口固定在周几？只回答星期。', needle: '四' },
  { id: 'page', kind: 'durable', statement: '分页上限我定成每页 37 条。', question: '分页上限每页多少条？只回答数字。', needle: '37' },
  // 关键细节（编号）在被索引行裁掉的那一段里：只有 recall_memory 能拿到
  { id: 'detail', kind: 'durable', statement: LONG_RATIONALE + '最终内部编号是 ZEBRA-42，排查问题时报这个编号。', question: '订单超时那个决策的内部编号是什么？只回答编号。', needle: 'ZEBRA-42' },
  // 长对照表：任何一句摘要都塞不进 120 字符的索引行，这一条**必须**走 recall_memory 读回正文
  {
    id: 'errors',
    kind: 'durable',
    statement: '错误码对照表（内部约定，别丢）：' + ERROR_MAP.map(([code, meaning]) => code + '=' + meaning).join('；') + '。',
    question: '错误码 E4217 对应什么意思？只回答它的含义。',
    needle: '退款批次冲突',
  },
  { id: 'transient-test', kind: 'transient', statement: '现在正在跑第 3 个测试用例，还没跑完。', question: '我刚才跑到第几个测试用例了？如果你并不知道，就回答"不知道"。', needle: '第 3 个' },
  { id: 'transient-debug', kind: 'transient', statement: '我临时把 DEBUG 日志打开了一下，等会儿会关掉。', question: 'DEBUG 日志现在是开着还是关着？如果你并不知道，就回答"不知道"。', needle: '开' },
]

const args = scriptArgs()
const rounds = Math.max(1, Number.parseInt(optionValue(args, '--rounds') ?? '1', 10))

const settings = await readSettings()
if (settings.apiKey === undefined) {
  console.error('DEEPSEEK_API_KEY is required (process environment or repository .env)')
  process.exit(2)
}
const adapterFactory = await createAdapterFactory(settings.apiKey, settings.model)

interface RoundResult {
  readonly recallHits: number
  readonly recallTotal: number
  readonly restraintHits: number
  readonly restraintTotal: number
  readonly recallCalls: number
  readonly memoryEntries: number
  readonly details: { fact: Fact; answer: string; pass: boolean }[]
}

async function runRound(round: number): Promise<RoundResult> {
  const root = mkdtempSync(join(tmpdir(), 'cubus-recall-' + String(round) + '-'))
  const memoryPath = join(root, 'memory.jsonl')
  const store = new MemoryStore({ path: memoryPath, io: nodeMemoryIO() })
  const build = () => new SessionRuntime({
    rootDir: join(root, 'sessions'),
    host: withToolApprovalHost(
      createLocalAgentHost({ adapterFactory, workspaceDir: root }),
      createStaticToolApproval('allow', 'recall eval'),
    ),
    recipe: withMemory(withContextCompaction(cubusCodingAgentRecipe, { contextWindow: 128_000 }), {
      store,
      indexLimit: DEFAULT_MEMORY_INDEX_LIMIT,
    }),
    recipeOptions: {
      memory: { path: memoryPath, entries: 0, indexLimit: DEFAULT_MEMORY_INDEX_LIMIT },
    },
    permissionProfile: 'allow',
    retry: { maxAttempts: 2 },
  })

  // 会话 A：种事实 + 提炼
  const runtimeA = build()
  const sessionA = await runtimeA.create()
  for (const fact of FACTS) await runtimeA.run(sessionA.id, fact.statement)
  const extraction = await runtimeA.run(sessionA.id, EXTRACT_INSTRUCTION)
  await storeCandidates(store, parseMemoryCandidates(extraction.assistantText ?? ''))
  const { entries } = await store.list()
  if (round === 1) {
    console.log('  会话 A 提炼出的记忆条目（' + String(entries.length) + ' 条）：')
    for (const entry of entries) {
      console.log('    ' + entry.id + ' ' + entry.text.replace(/\s+/g, ' ').slice(0, 110) + (entry.text.length > 110 ? '…（共 ' + String(entry.text.length) + ' 字符）' : ''))
    }
  }

  // 会话 B：全新会话、同一份记忆文件
  const runtimeB = build()
  const sessionB = await runtimeB.create()
  const details: { fact: Fact; answer: string; pass: boolean }[] = []
  let recallCalls = 0
  for (const fact of FACTS) {
    const run = await runtimeB.run(sessionB.id, fact.question)
    const answer = run.assistantText ?? ''
    recallCalls += run.turnEvents.filter(event => event.type === 'tool/call' && event.name === 'recall_memory').length
    const pass = fact.kind === 'durable' ? answer.includes(fact.needle) : !answer.includes(fact.needle)
    details.push({ fact, answer, pass })
  }

  const durable = details.filter(entry => entry.fact.kind === 'durable')
  const transient = details.filter(entry => entry.fact.kind === 'transient')
  return {
    recallHits: durable.filter(entry => entry.pass).length,
    recallTotal: durable.length,
    restraintHits: transient.filter(entry => entry.pass).length,
    restraintTotal: transient.length,
    recallCalls,
    memoryEntries: entries.length,
    details,
  }
}

const roundsResult: RoundResult[] = []
for (let round = 1; round <= rounds; round += 1) roundsResult.push(await runRound(round))

const sum = (pick: (result: RoundResult) => number): number => roundsResult.reduce((total, result) => total + pick(result), 0)
const recallHits = sum(result => result.recallHits)
const recallTotal = sum(result => result.recallTotal)
const restraintHits = sum(result => result.restraintHits)
const restraintTotal = sum(result => result.restraintTotal)
const recallCalls = sum(result => result.recallCalls)
const memoryEntries = Math.round(sum(result => result.memoryEntries) / roundsResult.length)
const recallRate = Math.round((recallHits / recallTotal) * 1000) / 10
const restraintRate = Math.round((restraintHits / restraintTotal) * 1000) / 10

console.log('跨会话召回评测（会话 A 说 → 会话 B 答）')
console.log('  模型 ' + settings.model + ' · 轮次 ' + String(rounds) + ' · 事实 ' + String(recallTotal) + ' 条 + 临时状态 ' + String(restraintTotal) + ' 条')
console.log('  记忆条目（平均）：' + String(memoryEntries) + ' · recall_memory 调用：' + String(recallCalls) + ' 次')
for (const entry of roundsResult[0]?.details ?? []) {
  console.log('  ' + (entry.pass ? '✓' : '✗') + ' [' + entry.fact.kind + '] ' + entry.fact.id.padEnd(15) +
    ' 实答: ' + entry.answer.replace(/\s+/g, ' ').slice(0, 50))
}
console.log('\n召回率（新会话答出旧会话的事实）：' + String(recallHits) + '/' + String(recallTotal) + ' = ' + String(recallRate) + '%')
console.log('克制率（临时状态没有被记住）：' + String(restraintHits) + '/' + String(restraintTotal) + ' = ' + String(restraintRate) + '%')

const record = {
  at: new Date().toISOString(),
  model: settings.model,
  rounds,
  facts: recallTotal,
  transient: restraintTotal,
  recallRate,
  restraintRate,
  recallCalls,
  memoryEntries,
}
writeFileSync(join(repositoryRoot, 'packages', 'evals', 'evals', 'evals-recall.json'), JSON.stringify(record, null, 2) + '\n')
appendFileSync(
  join(repositoryRoot, 'packages', 'evals', 'evals', 'EVALS.md'),
  '\n### 跨会话召回（S4.6）\n\n' +
  '- ' + record.at + ' · ' + record.model + ' · 轮次 ' + String(rounds) + ' · 事实 ' + String(recallTotal) +
  ' 条 + 临时状态 ' + String(restraintTotal) + ' 条 · 记忆条目 ' + String(memoryEntries) + '\n' +
  '- **召回率 ' + String(recallRate) + '%**（' + String(recallHits) + '/' + String(recallTotal) + '）' +
  ' · **克制率 ' + String(restraintRate) + '%**（' + String(restraintHits) + '/' + String(restraintTotal) + '）' +
  ' · recall_memory 调用 ' + String(recallCalls) + ' 次\n',
)
console.log('结果已写入 packages/evals/evals/evals-recall.json 与 EVALS.md')
process.exit(0)