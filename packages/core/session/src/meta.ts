/**
 * 会话格式版本（D3；设计见 docs/design/eval-suite-and-resume.md §6.1）。
 *
 * 版本放在 sidecar `session.meta.json`，**不放进事件流** —— 那样会新增事件类型，
 * 并且和"session/mount 必须是第一条"的不变量冲突。
 */

/**
 * v1 = D1 之前（无 session/mount、无 budget）；
 * v2 = 含装配快照与预算（B/C 阶段）；
 * v3 = 含 request/retry 事件与 turn/start|end 的 at 时间戳（F4b）。
 * 规则（D1 决定）：**新增事件类型算一次版本递增**（读取方据此拒绝过新的日志），新增可选字段不算。
 */
export const SESSION_FORMAT_VERSION = 3

export interface SessionMeta {
  readonly formatVersion: number
  readonly createdAt?: string
  readonly sessionId?: string
  readonly recipe?: { readonly id: string; readonly version: string }
}

export class SessionFormatError extends Error {
  readonly formatVersion: number

  constructor(message: string, formatVersion: number) {
    super(message)
    this.name = 'SessionFormatError'
    this.formatVersion = formatVersion
  }
}

export function renderSessionMeta(meta: SessionMeta): string {
  return JSON.stringify(meta, null, 2) + '\n'
}

/**
 * 读取方规则：
 * - 文件缺失 → 视为 **v1**（D1 之前的日志）；
 * - 版本高于本构建支持的版本 → **拒绝**并提示升级（不静默降级）。
 */
export function parseSessionMeta(raw: string | undefined, source = 'session.meta.json'): SessionMeta {
  if (raw === undefined) return { formatVersion: 1 }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new SessionFormatError(source + ': not valid JSON: ' + String(error), SESSION_FORMAT_VERSION)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SessionFormatError(source + ': expected a JSON object', SESSION_FORMAT_VERSION)
  }

  const record = parsed as Record<string, unknown>
  const formatVersion = record['formatVersion']
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new SessionFormatError(source + ': formatVersion must be a positive integer', SESSION_FORMAT_VERSION)
  }
  if (formatVersion > SESSION_FORMAT_VERSION) {
    throw new SessionFormatError(
      source + ': session log format version ' + String(formatVersion) +
      ' is newer than this build supports (' + String(SESSION_FORMAT_VERSION) +
      '); upgrade the tooling instead of downgrading the log',
      formatVersion,
    )
  }

  const createdAt = record['createdAt']
  const sessionId = record['sessionId']
  const recipe = record['recipe']
  return {
    formatVersion,
    ...(typeof createdAt === 'string' ? { createdAt } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof recipe === 'object' && recipe !== null &&
      typeof (recipe as Record<string, unknown>)['id'] === 'string' &&
      typeof (recipe as Record<string, unknown>)['version'] === 'string'
      ? { recipe: recipe as { id: string; version: string } }
      : {}),
  }
}
