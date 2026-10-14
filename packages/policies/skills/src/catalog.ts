import type { SkillFileIO, SkillIndexEntry, SkillRoot } from './load.ts'

export const READ_SKILL_TOOL = 'read_skill'
/** 单次返回的字符上限：技能不能自己撑爆窗口（与 read_session_log / recall_memory 同一条纪律）。 */
export const READ_SKILL_MAX_CHARS = 16_000

export class SkillNotFoundError extends Error {
  readonly available: readonly string[]

  constructor(name: string, available: readonly string[]) {
    super('没有名为 "' + name + '" 的技能。可用技能：' + (available.length === 0 ? '（当前没有任何技能）' : available.join(', ')))
    this.name = 'SkillNotFoundError'
    this.available = available
  }
}

export class SkillPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillPathError'
  }
}

export interface SkillCatalogOptions {
  readonly skills: readonly SkillIndexEntry[]
  /** 技能正文（按名字索引）—— loadSkills 已经读过一遍，不重复读。 */
  readonly bodies: ReadonlyMap<string, string>
  /** 技能根目录（用来定位附件；顺序与 loadSkills 一致，后者覆盖前者）。 */
  readonly roots: readonly SkillRoot[]
  readonly io: SkillFileIO
}

export interface SkillReadResult {
  readonly skill: string
  readonly text: string
  readonly truncated: boolean
  readonly totalChars: number
}

/**
 * 技能目录（S4b.3）：按名字读正文、按相对路径读附件。
 *
 * **附件路径必须限制在技能目录内**：技能是内容，不是越权通道。三层防护：
 * 1. 语法层：拒绝绝对路径与 `..` 段；
 * 2. 拼接层：拼成绝对路径后再做一次"必须在技能目录下"的检查；
 * 3. 真实路径层：`realpath` 之后再检查一次 —— 防符号链接逃逸（语法上看不出来的那种）。
 */
export class SkillCatalog {
  private readonly skills: readonly SkillIndexEntry[]
  private readonly bodies: ReadonlyMap<string, string>
  private readonly roots: readonly SkillRoot[]
  private readonly io: SkillFileIO

  constructor(options: SkillCatalogOptions) {
    this.skills = options.skills
    this.bodies = options.bodies
    this.roots = options.roots
    this.io = options.io
  }

  list(): readonly SkillIndexEntry[] {
    return this.skills
  }

  names(): readonly string[] {
    return this.skills.map(skill => skill.name)
  }

  /** 技能所在根目录的绝对路径（用 path 的首段定位是哪个 scope 的根）。 */
  private dirOf(entry: SkillIndexEntry): string | undefined {
    // loadSkills 记录的 path 形如 `<技能目录名>/SKILL.md`，技能目录名 = path 的第一段
    const dirName = entry.path.split('/')[0]
    if (dirName === undefined) return undefined
    return this.roots.find(root => root.source === entry.source) === undefined
      ? undefined
      : joinPath(this.roots.find(root => root.source === entry.source)?.dir ?? '', dirName)
  }

  private entryOf(name: string): SkillIndexEntry {
    const entry = this.skills.find(skill => skill.name === name)
    if (entry === undefined) throw new SkillNotFoundError(name, this.names())
    return entry
  }

  /** 读正文（frontmatter 已剥掉：给模型看的是说明书本身，不是元数据）。 */
  readBody(name: string): string {
    this.entryOf(name)
    const text = this.bodies.get(name)
    if (text === undefined) throw new SkillNotFoundError(name, this.names())
    return stripFrontmatter(text)
  }

  /** 读附件：`file` 是相对技能目录的路径。 */
  async readAttachment(name: string, file: string): Promise<string> {
    const entry = this.entryOf(name)
    const dir = this.dirOf(entry)
    if (dir === undefined) throw new SkillPathError('cannot locate the directory of skill "' + name + '"')
    const relative = normalizeRelative(file)
    const target = joinPath(dir, relative)
    if (!isInside(dir, target)) throw new SkillPathError('attachment path escapes the skill directory: ' + file)
    const realDir = await this.io.realpath(dir)
    const realTarget = await this.io.realpath(target)
    if (!isInside(realDir, realTarget)) {
      throw new SkillPathError('attachment path resolves outside the skill directory (symlink?): ' + file)
    }
    return await this.io.readText(target)
  }
}

function joinPath(dir: string, name: string): string {
  return name === '' ? dir : dir.replace(/\/+$/, '') + '/' + name
}

/** 语法层：拒绝绝对路径与 `..` 段，并把 `./` 前缀去掉。 */
export function normalizeRelative(file: string): string {
  if (file.trim() === '') throw new SkillPathError('attachment path must not be empty')
  const normalized = file.replace(/^\.\//, '')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new SkillPathError('attachment path must be relative to the skill directory: ' + file)
  }
  const segments = normalized.split('/')
  if (segments.includes('..')) throw new SkillPathError('attachment path must not contain "..": ' + file)
  return segments.filter(segment => segment !== '' && segment !== '.').join('/')
}

/** 拼接层与真实路径层共用的"必须在目录内"判定。 */
export function isInside(dir: string, target: string): boolean {
  const base = dir.replace(/\/+$/, '')
  return target === base || target.startsWith(base + '/')
}

function stripFrontmatter(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(text)
  return match === null ? text : text.slice(match[0].length)
}

/** 截断到上限（明确标注，不静默丢）。 */
export function capSkillText(text: string, maxChars = READ_SKILL_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: text.slice(0, maxChars) + '\n\n（内容超过 ' + String(maxChars) + ' 字符，已截断；原文 ' + String(text.length) + ' 字符。）',
    truncated: true,
  }
}
