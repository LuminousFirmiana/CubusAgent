import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { isSettled, parseSessionMeta, planSettlement, SESSION_FORMAT_VERSION } from '@cubus/session'
import { readSessionEvents } from './sessions.ts'

/**
 * 会话日志归档（F3）：让日志成为**可搬运的资产**（备份、换机器、给别人看）。
 *
 * 归档是**目录**而不是压缩包：日志保持原样的 JSONL，人能直接读、能 diff，
 * 也不引入任何依赖。完整性用 manifest 里的 sha256 校验（导入时逐文件核对）。
 *
 * 安全约束（导入是不可信输入）：
 * - 只搬运固定白名单的两个文件（session.jsonl / session.meta.json），因此不存在路径穿越；
 * - 会话 id 必须匹配安全字符集，且不能是 . 或 ..；
 * - 格式版本过新一律拒绝（与读取规则一致：升级工具，而不是降级日志）。
 */

export const ARCHIVE_FORMAT_VERSION = 1
export const ARCHIVE_MANIFEST = 'manifest.json'
/** 归档里允许出现的文件：白名单写死，杜绝任何路径穿越。 */
export const ARCHIVED_FILES: readonly string[] = ['session.jsonl', 'session.meta.json']

export interface ArchivedFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface ArchivedSession {
  readonly id: string
  readonly formatVersion: number
  readonly files: readonly ArchivedFile[]
}

export interface ArchiveManifest {
  readonly version: number
  readonly createdAt: string
  readonly source: string
  readonly sessions: readonly ArchivedSession[]
}

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveError'
  }
}

function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id === '..' || id.includes('..')) {
    throw new ArchiveError('unsafe session id in archive: ' + JSON.stringify(id))
  }
}

async function sha256Of(path: string): Promise<{ bytes: number; sha256: string }> {
  const content = await readFile(path)
  return { bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') }
}

/** 导出会话（可指定 id 子集）；返回写出的 manifest。 */
export async function exportSessions(options: {
  sessionsDir: string
  outDir: string
  ids?: readonly string[]
  now?: () => number
}): Promise<ArchiveManifest> {
  const sessionsDir = resolve(options.sessionsDir)
  const outDir = resolve(options.outDir)
  if (outDir === sessionsDir || outDir.startsWith(sessionsDir + sep)) {
    throw new ArchiveError('archive output must not live inside the sessions directory')
  }

  const entries = (await readdir(sessionsDir, { withFileTypes: true })).filter(entry => entry.isDirectory())
  const wanted = options.ids === undefined ? undefined : new Set(options.ids)
  const sessions: ArchivedSession[] = []

  await mkdir(outDir, { recursive: true })
  for (const entry of entries) {
    if (wanted !== undefined && !wanted.has(entry.name)) continue
    assertSafeId(entry.name)
    const from = join(sessionsDir, entry.name)
    const to = join(outDir, 'sessions', entry.name)
    await mkdir(to, { recursive: true })

    const files: ArchivedFile[] = []
    for (const name of ARCHIVED_FILES) {
      const source = join(from, name)
      const exists = await stat(source).then(() => true, () => false)
      if (!exists) continue
      await cp(source, join(to, name))
      files.push({ path: name, ...(await sha256Of(source)) })
    }

    const rawMeta = await readFile(join(from, 'session.meta.json'), 'utf8').catch(() => undefined)
    const meta = parseSessionMeta(rawMeta)
    sessions.push({ id: entry.name, formatVersion: meta.formatVersion, files })
  }

  sessions.sort((left, right) => (left.id < right.id ? -1 : 1))
  const manifest: ArchiveManifest = {
    version: ARCHIVE_FORMAT_VERSION,
    createdAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    source: sessionsDir,
    sessions,
  }
  await writeFile(join(outDir, ARCHIVE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return manifest
}

export interface ImportResult {
  readonly imported: readonly string[]
  readonly skipped: readonly { readonly id: string; readonly reason: string }[]
}

export function parseArchiveManifest(raw: string, source: string): ArchiveManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ArchiveError(source + ': not valid JSON: ' + String(error))
  }
  const record = parsed as Partial<ArchiveManifest>
  if (record.version !== ARCHIVE_FORMAT_VERSION) {
    throw new ArchiveError(
      source + ': unsupported archive version ' + String(record.version) + ' (this build reads ' + String(ARCHIVE_FORMAT_VERSION) + ')',
    )
  }
  if (!Array.isArray(record.sessions)) throw new ArchiveError(source + ': sessions must be an array')
  for (const session of record.sessions) {
    assertSafeId(session.id)
    for (const file of session.files) {
      if (!ARCHIVED_FILES.includes(file.path)) {
        throw new ArchiveError(source + ': archive tries to import an unexpected file: ' + JSON.stringify(file.path))
      }
    }
  }
  return record as ArchiveManifest
}

/** 导入归档：逐文件校验 sha256 与格式版本；id 冲突时按 rename 决定改名还是拒绝。 */
export async function importSessions(options: {
  archiveDir: string
  sessionsDir: string
  rename?: boolean
}): Promise<ImportResult> {
  const archiveDir = resolve(options.archiveDir)
  const sessionsDir = resolve(options.sessionsDir)
  const manifest = parseArchiveManifest(
    await readFile(join(archiveDir, ARCHIVE_MANIFEST), 'utf8').catch(() => {
      throw new ArchiveError('no ' + ARCHIVE_MANIFEST + ' in ' + archiveDir)
    }),
    join(archiveDir, ARCHIVE_MANIFEST),
  )

  const imported: string[] = []
  const skipped: { id: string; reason: string }[] = []
  await mkdir(sessionsDir, { recursive: true })

  for (const session of manifest.sessions) {
    if (session.formatVersion > SESSION_FORMAT_VERSION) {
      skipped.push({
        id: session.id,
        reason:
          'session log format version ' + String(session.formatVersion) +
          ' is newer than this build supports (' + String(SESSION_FORMAT_VERSION) + ')',
      })
      continue
    }

    let targetId = session.id
    const existing = await stat(join(sessionsDir, targetId)).then(() => true, () => false)
    if (existing) {
      if (options.rename !== true) {
        skipped.push({ id: session.id, reason: 'already present in the sessions directory (pass --rename to import as a copy)' })
        continue
      }
      let suffix = 1
      while (await stat(join(sessionsDir, targetId + '-imported-' + String(suffix))).then(() => true, () => false)) {
        suffix += 1
      }
      targetId = targetId + '-imported-' + String(suffix)
    }

    // 先把整个会话校验完再落盘：半途失败不留残缺会话
    const verified: { path: string; content: Buffer }[] = []
    for (const file of session.files) {
      const content = await readFile(join(archiveDir, 'sessions', session.id, file.path))
      const digest = createHash('sha256').update(content).digest('hex')
      if (digest !== file.sha256 || content.byteLength !== file.bytes) {
        throw new ArchiveError(
          'checksum mismatch for ' + session.id + '/' + file.path + ' (archive is corrupted or was edited)',
        )
      }
      verified.push({ path: file.path, content })
    }

    const target = join(sessionsDir, targetId)
    await mkdir(target, { recursive: true })
    for (const file of verified) await writeFile(join(target, file.path), file.content)
    imported.push(targetId)
  }

  return { imported, skipped }
}

export interface PrunePlan {
  readonly remove: readonly string[]
  readonly keep: readonly { readonly id: string; readonly reason: string }[]
}

/**
 * 清理计划（**纯计算，不删任何东西**）：
 * - 默认保留"待恢复"（未闭合）的会话 —— 那可能是有用的现场；
 * - 只删早于 olderThanMs 的会话（默认 30 天）；
 * - 删除是破坏性的：调用方必须先看计划再决定执行（CLI 默认 dry-run）。
 */
export async function planPrune(options: {
  sessionsDir: string
  olderThanMs?: number
  keepNeedingSettlement?: boolean
  now?: () => number
}): Promise<PrunePlan> {
  const sessionsDir = resolve(options.sessionsDir)
  const now = options.now?.() ?? Date.now()
  const cutoff = now - (options.olderThanMs ?? 30 * 24 * 60 * 60 * 1000)
  const keepNeedingSettlement = options.keepNeedingSettlement ?? true

  const entries = (await readdir(sessionsDir, { withFileTypes: true })).filter(entry => entry.isDirectory())
  const remove: string[] = []
  const keep: { id: string; reason: string }[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const directory = join(sessionsDir, entry.name)
    const logPath = join(directory, 'session.jsonl')
    const info = await stat(logPath).catch(() => undefined)
    if (info === undefined) {
      keep.push({ id: entry.name, reason: 'no session.jsonl' })
      continue
    }
    if (info.mtimeMs > cutoff) {
      keep.push({ id: entry.name, reason: 'newer than the cutoff' })
      continue
    }
    if (keepNeedingSettlement) {
      // 真判据（不是猜字符串）：未闭合的 turn 说明这是崩溃现场，默认留着
      const { events } = await readSessionEvents(logPath)
      if (!isSettled(planSettlement(events))) {
        keep.push({ id: entry.name, reason: 'needs settlement (crashed session)' })
        continue
      }
    }
    remove.push(entry.name)
  }

  remove.sort()
  return { remove, keep }
}

/** 执行清理：只删计划里的 id，且逐个确认落在 sessions 目录内。 */
export async function applyPrune(options: { sessionsDir: string; plan: PrunePlan }): Promise<readonly string[]> {
  const sessionsDir = resolve(options.sessionsDir)
  const removed: string[] = []
  for (const id of options.plan.remove) {
    assertSafeId(id)
    const target = join(sessionsDir, id)
    // 双保险：目标必须真的在 sessions 目录下（不做任何"计算出来的路径"上的删除）
    if (resolve(target) !== join(sessionsDir, id) || !resolve(target).startsWith(sessionsDir + sep)) {
      throw new ArchiveError('refusing to delete outside the sessions directory: ' + target)
    }
    await rm(target, { recursive: true, force: true })
    removed.push(id)
  }
  return removed
}
