/**
 * 归档 CLI（F3）：导出 / 导入 / 清理会话日志。
 *
 *   pnpm run archive -- --export <dir> [--session <id>]...   # 备份（可只导指定会话）
 *   pnpm run archive -- --import <dir> [--rename]            # 恢复（id 冲突时改名）
 *   pnpm run archive -- --prune [--older-than-days 30] [--include-crashed] [--yes]
 *
 * 两条纪律：
 * 1. **删除默认是 dry-run**：不加 --yes 只打印计划（含绝对路径），由人确认；
 * 2. 崩溃现场（未闭合回合）默认保留：那可能是有用的现场，不该被"清理"掉。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  applyPrune,
  exportSessions,
  importSessions,
  planPrune,
} from '@cubus/sdk'
import type { PrunePlan } from '@cubus/sdk'
import { configPathFrom, readWorkbenchConfig } from './config-file.ts'

export class ArchiveUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveUsageError'
  }
}

export interface ArchiveCommandOptions {
  readonly sessionsDir: string
  readonly mode: 'export' | 'import' | 'prune'
  readonly path?: string
  readonly sessionIds: readonly string[]
  readonly rename: boolean
  readonly olderThanDays: number
  readonly keepNeedingSettlement: boolean
  readonly yes: boolean
}

export function parseArchiveCommand(
  argv: readonly string[],
  fallbackSessionsDir: string | undefined,
): ArchiveCommandOptions {
  const args = argv[0] === '--' ? argv.slice(1) : argv
  let sessionsDir = fallbackSessionsDir
  let mode: ArchiveCommandOptions['mode'] | undefined
  let path: string | undefined
  const sessionIds: string[] = []
  let rename = false
  let olderThanDays = 30
  let keepNeedingSettlement = true
  let yes = false

  const value = (index: number, option: string): string => {
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) throw new ArchiveUsageError(option + ' requires a value')
    return next
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--export' || arg === '--import') {
      if (mode !== undefined) throw new ArchiveUsageError('pick exactly one of --export / --import / --prune')
      mode = arg === '--export' ? 'export' : 'import'
      path = value(index, arg)
      index += 1
      continue
    }
    if (arg === '--prune') {
      if (mode !== undefined) throw new ArchiveUsageError('pick exactly one of --export / --import / --prune')
      mode = 'prune'
      continue
    }
    if (arg === '--sessions') {
      sessionsDir = value(index, arg)
      index += 1
      continue
    }
    if (arg === '--session') {
      sessionIds.push(value(index, arg))
      index += 1
      continue
    }
    if (arg === '--rename') {
      rename = true
      continue
    }
    if (arg === '--older-than-days') {
      const days = Number(value(index, arg))
      if (!Number.isInteger(days) || days < 0) throw new ArchiveUsageError('--older-than-days must be a non-negative integer')
      olderThanDays = days
      index += 1
      continue
    }
    if (arg === '--include-crashed') {
      keepNeedingSettlement = false
      continue
    }
    if (arg === '--yes') {
      yes = true
      continue
    }
    throw new ArchiveUsageError('unknown option: ' + String(arg))
  }

  if (mode === undefined) throw new ArchiveUsageError('pick one of --export <dir> / --import <dir> / --prune')
  return {
    // 与 CLI/工作台同一个默认位置：~/.cubus/sessions（规则只有一条：配置 > 默认）
    sessionsDir: resolve(sessionsDir ?? join(homedir(), '.cubus', 'sessions')),
    mode,
    ...(path === undefined ? {} : { path: resolve(path) }),
    sessionIds,
    rename,
    olderThanDays,
    keepNeedingSettlement,
    yes,
  }
}

/** 清理计划的**可读报告**：删除会列绝对路径，让人先看清再决定。 */
export function renderPrunePlan(plan: PrunePlan, sessionsDir: string, willDelete: boolean): string {
  const lines: string[] = []
  lines.push('sessions dir: ' + sessionsDir)
  lines.push('would delete: ' + String(plan.remove.length))
  for (const id of plan.remove) lines.push('  ' + resolve(sessionsDir, id))
  lines.push('keep: ' + String(plan.keep.length))
  for (const entry of plan.keep.slice(0, 20)) lines.push('  ' + entry.id + '  (' + entry.reason + ')')
  if (plan.keep.length > 20) lines.push('  … 还有 ' + String(plan.keep.length - 20) + ' 个')
  lines.push('')
  lines.push(willDelete ? 'deleting (--yes was given)' : 'dry run: nothing was deleted (pass --yes to delete)')
  return lines.join('\n')
}

export async function main(argv: readonly string[]): Promise<number> {
  const configPath = configPathFrom({ env: process.env })
  const loaded = await readWorkbenchConfig(configPath).catch(() => undefined)
  const options = parseArchiveCommand(argv, loaded?.config.sessionsDir)

  if (options.mode === 'export') {
    if (options.path === undefined) throw new ArchiveUsageError('--export requires a directory')
    const manifest = await exportSessions({
      sessionsDir: options.sessionsDir,
      outDir: options.path,
      ...(options.sessionIds.length === 0 ? {} : { ids: options.sessionIds }),
    })
    process.stdout.write('exported ' + String(manifest.sessions.length) + ' session(s) to ' + options.path + '\n')
    for (const session of manifest.sessions) {
      const bytes = session.files.reduce((sum, file) => sum + file.bytes, 0)
      process.stdout.write('  ' + session.id + '  v' + String(session.formatVersion) + '  ' + String(bytes) + ' bytes\n')
    }
    return 0
  }

  if (options.mode === 'import') {
    if (options.path === undefined) throw new ArchiveUsageError('--import requires a directory')
    const result = await importSessions({
      archiveDir: options.path,
      sessionsDir: options.sessionsDir,
      rename: options.rename,
    })
    process.stdout.write('imported ' + String(result.imported.length) + ' session(s)\n')
    for (const id of result.imported) process.stdout.write('  ' + id + '\n')
    for (const entry of result.skipped) process.stdout.write('  skipped ' + entry.id + ': ' + entry.reason + '\n')
    return 0
  }

  const plan = await planPrune({
    sessionsDir: options.sessionsDir,
    olderThanMs: options.olderThanDays * 24 * 60 * 60 * 1000,
    keepNeedingSettlement: options.keepNeedingSettlement,
  })
  process.stdout.write(renderPrunePlan(plan, options.sessionsDir, options.yes) + '\n')
  if (options.yes) await applyPrune({ sessionsDir: options.sessionsDir, plan })
  return 0
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (isMain) {
  main(process.argv.slice(2)).catch(error => {
    if (error instanceof ArchiveUsageError) {
      process.stderr.write(error.message + '\n')
      process.exit(2)
    }
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n')
    process.exit(1)
  })
}
