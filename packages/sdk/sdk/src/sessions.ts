import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isSettled, parseSessionMeta, planSettlement } from '@cubus/session'
import type { BudgetLimits, SessionEvent } from '@cubus/session'

/**
 * 会话目录的读取侧（E1）：给工作台/CLI 用的"看历史"能力。
 *
 * 与运行时的关系：运行时装会话（内存 + 日志写入），这里只读已经落在磁盘上的会话目录。
 * 因此它对**本进程没打开过的会话**同样有效 —— 这正是工作台列出历史会话所需要的能力。
 */

export interface SessionSummary {
  readonly id: string
  readonly directory: string
  readonly logPath: string
  /** sidecar 记录的格式版本（缺失 = 1）；读不出来则缺省并记进 problems。 */
  readonly formatVersion?: number
  readonly createdAt?: string
  readonly recipe?: { readonly id: string; readonly version: string }
  /** 装配快照里的能力（'kind:provider'）。 */
  readonly capabilities?: readonly string[]
  readonly permissionProfile?: string
  readonly budget?: BudgetLimits
  readonly eventCount: number
  readonly lastEventType?: string
  /** 崩溃留下的未闭合区间（D3 的结算判据）：为 true 时该会话需要 resume。 */
  readonly needsSettlement: boolean
  /** 读取中的问题（例如格式版本过高）；非空 = 这条摘要不完整，界面应显示出来。 */
  readonly problems: readonly string[]
}

/**
 * 容错读取 JSONL 日志：崩溃可能留下**半行**，只容忍最后一行不完整；
 * 中间出现坏行属于数据损坏，必须报出来而不是悄悄跳过。
 */
export async function readSessionEvents(
  logPath: string,
): Promise<{ events: SessionEvent[]; truncated: boolean }> {
  let raw: string
  try {
    raw = await readFile(logPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], truncated: false }
    throw error
  }

  const lines = raw.split('\n')
  const lastContentIndex = lines.reduce((last, line, index) => (line.trim() === '' ? last : index), -1)
  const events: SessionEvent[] = []
  let truncated = false
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line) as SessionEvent)
    } catch (error) {
      if (index === lastContentIndex) {
        truncated = true
        continue
      }
      throw new Error(
        'session log is corrupted at line ' + String(index + 1) + ' of ' + logPath + ': ' + String(error),
      )
    }
  }
  return { events, truncated }
}

/** 读一个会话目录，产出摘要（单个会话读不出来时只记 problems，不抛）。 */
export async function readSessionSummary(directory: string): Promise<SessionSummary> {
  const id = directory.split('/').filter(Boolean).at(-1) ?? directory
  const logPath = join(directory, 'session.jsonl')
  const problems: string[] = []

  const rawMeta = await readFile(join(directory, 'session.meta.json'), 'utf8').catch(() => undefined)
  let formatVersion: number | undefined
  let createdAt: string | undefined
  let recipe: { id: string; version: string } | undefined
  try {
    const meta = parseSessionMeta(rawMeta)
    formatVersion = meta.formatVersion
    createdAt = meta.createdAt
    recipe = meta.recipe === undefined ? undefined : { id: meta.recipe.id, version: meta.recipe.version }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }

  let events: SessionEvent[] = []
  try {
    events = (await readSessionEvents(logPath)).events
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }

  const mount = events.find(event => event.type === 'session/mount')
  const snapshot = mount?.type === 'session/mount' ? mount.mount : undefined
  const lastEvent = events.at(-1)

  return {
    id,
    directory,
    logPath,
    ...(formatVersion === undefined ? {} : { formatVersion }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(recipe === undefined ? {} : { recipe }),
    ...(snapshot === undefined
      ? {}
      : {
          capabilities: snapshot.capabilities.map(capability => capability.kind + ':' + capability.provider),
          permissionProfile: snapshot.permission.profile,
          ...(snapshot.budget === undefined ? {} : { budget: snapshot.budget }),
        }),
    eventCount: events.length,
    ...(lastEvent === undefined ? {} : { lastEventType: lastEvent.type }),
    needsSettlement: !isSettled(planSettlement(events)),
    problems,
  }
}

/** 列出会话目录下的全部会话（新的在前；读不出来的会话也在列表里，带 problems）。 */
export async function listSessions(rootDir: string): Promise<SessionSummary[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => [])
  const summaries: SessionSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    // 隐藏目录（.git、编辑器杂物）不是会话
    if (entry.name.startsWith('.')) continue
    summaries.push(await readSessionSummary(join(rootDir, entry.name)))
  }
  summaries.sort((left, right) => {
    const leftKey = left.createdAt ?? ''
    const rightKey = right.createdAt ?? ''
    if (leftKey !== rightKey) return leftKey < rightKey ? 1 : -1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  return summaries
}
