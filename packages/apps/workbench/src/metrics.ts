/**
 * 指标 CLI（F4）：把会话日志里的数字算出来，给人看或给机器读。
 *
 *   pnpm run metrics                      # 用 ~/.cubus/config.json 里的 sessionsDir
 *   pnpm run metrics -- --sessions <dir>  # 指定会话目录
 *   pnpm run metrics -- --json            # 机器可读（含比率与按工具名）
 *
 * 只读日志，不改任何东西；算不出来的指标（耗时、重试率）在报告末尾写明原因。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { collectMetrics } from '@cubus/sdk'
import type { MetricsSummary } from '@cubus/sdk'
import { configPathFrom, readWorkbenchConfig } from './config-file.ts'

export class MetricsUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetricsUsageError'
  }
}

export interface MetricsCommandOptions {
  readonly sessionsDir: string
  readonly json: boolean
}

export function parseMetricsCommand(
  argv: readonly string[],
  fallbackSessionsDir: string | undefined,
): MetricsCommandOptions {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let sessionsDir = fallbackSessionsDir
  let json = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--sessions') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new MetricsUsageError('--sessions requires a value')
      }
      sessionsDir = value
      index += 1
      continue
    }
    throw new MetricsUsageError('unknown option: ' + String(arg))
  }
  // 与 CLI/工作台同一个默认位置：~/.cubus/sessions（都走"配置 > 默认"这一条规则）
  return {
    sessionsDir: resolve(sessionsDir ?? join(homedir(), '.cubus', 'sessions')),
    json,
  }
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : (value * 100).toFixed(1) + '%'
}

/** 人类可读报告（确定性：同样的输入永远同样的输出，便于当基线对比）。 */
export function renderMetricsReport(summary: MetricsSummary, sessionsDir: string): string {
  const { totals, rates } = summary
  const lines: string[] = []
  lines.push('sessions: ' + String(totals.sessions) + '  (' + sessionsDir + ')')
  lines.push(
    'turns:    ' + String(totals.turns) +
    '  (cancelled ' + String(totals.cancelledTurns) + ' -> ' + percent(rates.turnCancellation) +
    ', settled by recovery ' + String(totals.settledTurns) + ')',
  )
  lines.push('steps:    ' + String(totals.steps))
  lines.push(
    'tools:    ' + String(totals.toolCalls) +
    '  (failed ' + String(totals.toolFailures) + ' -> ' + percent(rates.toolFailure) +
    ', denied by approval ' + String(totals.toolDenials) + ' -> ' + percent(rates.toolDenial) + ')',
  )
  const cacheShare = totals.tokens.prompt === 0 ? null : totals.tokens.cached / totals.tokens.prompt
  lines.push(
    'tokens:   ' + totals.tokens.total.toLocaleString('en-US') +
    '  (prompt ' + totals.tokens.prompt.toLocaleString('en-US') +
    ' / completion ' + totals.tokens.completion.toLocaleString('en-US') +
    ' / cached ' + totals.tokens.cached.toLocaleString('en-US') + ' -> ' + percent(cacheShare) + ' of prompt)',
  )
  lines.push(
    'per response: ' + (rates.tokensPerUsageMessage === null ? 'n/a' : Math.round(rates.tokensPerUsageMessage).toLocaleString('en-US')) +
    ' tokens  (' + String(totals.usageMessages) + ' responses with usage)',
  )
  lines.push('retries:  ' + String(totals.retries) + '  (' + percent(rates.retry) + ' of model requests)')
  lines.push(
    'turn time: ' + (rates.turnDurationMs === null ? 'n/a' : (rates.turnDurationMs / 1000).toFixed(1) + 's') +
    '  (slowest ' + (totals.durationMs.max / 1000).toFixed(1) + 's, ' + String(totals.durationMs.turns) + ' timed turns)',
  )
  const tools = Object.entries(totals.toolCallsByName).sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
  lines.push('by tool:  ' + (tools.length === 0 ? '(none)' : tools.map(([name, count]) => name + ' ' + String(count)).join(', ')))
  lines.push('')
  lines.push('per session:')
  for (const session of summary.sessions.slice(0, 20)) {
    lines.push(
      '  ' + session.sessionId.slice(0, 12).padEnd(14) +
      ' turns ' + String(session.turns) +
      ' · steps ' + String(session.steps) +
      ' · tools ' + String(session.toolCalls) +
      ' · tokens ' + String(session.tokens.total) +
      (session.needsSettlement ? ' · 待恢复' : ''),
    )
  }
  if (summary.sessions.length > 20) lines.push('  … 还有 ' + String(summary.sessions.length - 20) + ' 个会话')
  return lines.join('\n')
}

export async function main(argv: readonly string[]): Promise<number> {
  const configPath = configPathFrom({ env: process.env })
  const loaded = await readWorkbenchConfig(configPath).catch(() => undefined)
  const options = parseMetricsCommand(argv, loaded?.config.sessionsDir)
  const summary = await collectMetrics(options.sessionsDir)
  if (options.json) {
    process.stdout.write(JSON.stringify({ sessionsDir: options.sessionsDir, ...summary }, null, 2) + '\n')
    return 0
  }
  process.stdout.write(renderMetricsReport(summary, options.sessionsDir) + '\n')
  return 0
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (isMain) {
  main(process.argv.slice(2)).catch(error => {
    if (error instanceof MetricsUsageError) {
      process.stderr.write(error.message + '\n')
      process.exit(2)
    }
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
    process.exit(1)
  })
}
