import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectProjectStats } from './collect.ts'
import type { ProjectStats } from './collect.ts'

/** docs/stats.md 的生成（S7.1）：**它是产物，不是手写的文档**。 */
export function renderStats(stats: ProjectStats, meta: { readonly at: string; readonly tests: number }): string {
  const lines = [
    '# 项目规模（自动生成）',
    '',
    '> 本文件由 `pnpm run stats` 生成，**不要手改**。',
    '> 理由：手抄的数字会在某次提交后悄悄过期，而"过期但看起来权威"的数字比没有数字更糟。',
    '',
    '生成时间：' + meta.at,
    '',
    '| 事实 | 数值 | 怎么算出来的 |',
    '|---|---|---|',
    '| 包 | ' + String(stats.packages) + ' | `packages/<组>/<包>/package.json` 的个数 |',
    '| 会话日志事件类型 | ' + String(stats.eventKinds) + ' | `core/session/src/types.ts` 联合类型里 `type: \'…\'` 的个数 |',
    '| 环境能力种数 | ' + String(stats.capabilityKinds) + ' | `CAPABILITY_KINDS` 数组长度（**封闭集合**：新增一种能力 = 改内核） |',
    '| 测试文件 | ' + String(stats.testFiles) + ' | 各包 test 目录下的 `.test.ts` |',
    '| 测试声明 | ' + String(stats.testDeclarations) + ' | 源码里 `test(`/`it(` 的个数（近似；**权威数字是 `pnpm run check` 的运行结果**） |',
    '| 真容器集成测试 | ' + String(stats.containerTests) + ' | `hosts/docker` 的测试声明数 |',
    '| 测试通过数（最近一次全量检查） | ' + String(meta.tests) + ' | `pnpm run check` 输出里的 `Tests N passed` 求和（由调用方传入） |',
    '',
  ]
  if (stats.evals.length > 0) {
    lines.push('## 评测实测（真模型）', '', '| 评测 | 结果 |', '|---|---|')
    for (const evaluation of stats.evals) lines.push('| ' + evaluation.name + ' | ' + evaluation.summary + ' |')
    lines.push('')
  }
  lines.push(
    '## 怎么重新生成',
    '',
    '```bash',
    'pnpm run check 2>&1 | tee /tmp/check.log   # 拿到权威的测试通过数',
    'pnpm run stats -- --check-log /tmp/check.log',
    '```',
    '',
  )
  return lines.join('\n')
}

/** 从 `pnpm run check` 的日志里取测试通过数（各包 vitest 输出之和）。 */
export function parseTestTotal(checkLog: string): number {
  let total = 0
  for (const match of checkLog.matchAll(/Tests\s+(\d+) passed/g)) total += Number.parseInt(match[1] ?? '0', 10)
  return total
}

// 直接运行：打印表格；`--write` 时同时写 docs/stats.md（--check-log 提供权威测试数）
if (process.argv[1]?.endsWith('render.ts') === true) {
  const { readFileSync } = await import('node:fs')
  const args = process.argv.slice(2)
  const logIndex = args.indexOf('--check-log')
  const logPath = logIndex >= 0 ? args[logIndex + 1] : undefined
  let tests = 0
  if (logPath !== undefined) {
    try {
      tests = parseTestTotal(readFileSync(logPath, 'utf8'))
    } catch {
      tests = 0
    }
  }
  const repositoryRoot = join(import.meta.dirname, '..', '..', '..', '..')
  const markdown = renderStats(collectProjectStats(repositoryRoot), { at: new Date().toISOString(), tests })
  if (args.includes('--write')) {
    writeFileSync(join(repositoryRoot, 'docs', 'stats.md'), markdown, 'utf8')
    console.log('written: docs/stats.md')
  } else {
    console.log(markdown)
  }
}
