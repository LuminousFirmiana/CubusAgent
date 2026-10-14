import { createHash } from 'node:crypto'

/** 一个技能在索引里的样子：**够模型判断"要不要用"**，不含正文。 */
export interface SkillIndexEntry {
  readonly name: string
  readonly description: string
  /** 何时用（可选的那半句说明）。 */
  readonly when?: string
  readonly source: 'user' | 'project'
  /** 相对技能根目录的路径（如 `release/SKILL.md`）。 */
  readonly path: string
  readonly sha256: string
  /** 技能目录里除 SKILL.md 之外的文件数（模板/脚本）。 */
  readonly attachmentCount: number
}

export interface SkillLoadLimits {
  /** 最多收录几个技能（超出按名字排序截断，并给出说明）。 */
  readonly maxSkills: number
  /** 索引里单条描述的最大字符数（超出截断并标注）。 */
  readonly maxDescriptionChars: number
}

export const DEFAULT_SKILL_LIMITS: SkillLoadLimits = { maxSkills: 20, maxDescriptionChars: 120 }

export interface SkillFileIO {
  /** 读文本文件（不存在时抛错即可）。 */
  readonly readText: (path: string) => Promise<string>
  /** 列目录（不存在时抛错即可）。 */
  readonly readDir: (path: string) => Promise<readonly string[]>
  /** 是否是目录（用于区分附件与子目录）。 */
  readonly isDirectory: (path: string) => Promise<boolean>
  /** 真实路径（用于附件读取的符号链接逃逸检查）。 */
  readonly realpath: (path: string) => Promise<string>
}

export interface SkillRoot {
  readonly source: 'user' | 'project'
  readonly dir: string
}

export class SkillFormatError extends Error {
  readonly source: string

  constructor(source: string, message: string) {
    super(source + ': ' + message)
    this.name = 'SkillFormatError'
    this.source = source
  }
}

export interface ParsedSkill {
  readonly name?: string
  readonly description: string
  readonly when?: string
}

/**
 * 解析 SKILL.md 的 frontmatter（最小子集：`key: value` 一行一条，不引 YAML 依赖）。
 *
 * **缺 description 直接报错**：索引里没描述，模型无法判断该不该用这个技能 —— 那等于没写。
 * `name` 可以缺（用目录名兜底），但给了就必须非空。
 */
export function parseSkillFrontmatter(text: string, source: string): ParsedSkill {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (match === null) throw new SkillFormatError(source, 'missing frontmatter: the file must start with a --- fenced block')
  const fields = new Map<string, string>()
  for (const line of (match[1] ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf(':')
    if (separator <= 0) throw new SkillFormatError(source, 'frontmatter line is not "key: value": ' + trimmed)
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (!['name', 'description', 'when'].includes(key)) {
      throw new SkillFormatError(source, 'unknown frontmatter key "' + key + '" (known: name, description, when)')
    }
    fields.set(key, value)
  }
  const description = fields.get('description')
  if (description === undefined || description === '') {
    throw new SkillFormatError(source, 'frontmatter must define a non-empty description (an index entry without one is useless to the model)')
  }
  const name = fields.get('name')
  if (name !== undefined && name === '') throw new SkillFormatError(source, 'frontmatter name must not be empty')
  const when = fields.get('when')
  return {
    ...(name === undefined ? {} : { name }),
    description,
    ...(when === undefined || when === '' ? {} : { when }),
  }
}

/** 去掉 frontmatter，返回正文（S4b.3 的 read_skill 用它）。 */
export function skillBody(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(text)
  return match === null ? text : text.slice(match[0].length)
}

/**
 * 数技能目录里的附件（递归）。
 *
 * 注意：**SKILL.md 自己不算附件** —— 它只在技能目录的第一层被排除（子目录里同名的文件算附件，
 * 那是有意为之：附件里放一份同名模板不稀奇）。第一版把相对路径写成了 `entry/SKILL.md` 再比
 * `'SKILL.md'`，结果 SKILL.md 被算成一个附件（测试抓到了）。
 */
async function listAttachments(io: SkillFileIO, dir: string, relative = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await io.readDir(joinPath(dir, relative))) {
    const child = relative === '' ? entry : relative + '/' + entry
    if (await io.isDirectory(joinPath(dir, child))) {
      files.push(...await listAttachments(io, dir, child))
    } else if (child !== 'SKILL.md') {
      files.push(child)
    }
  }
  return files
}

function joinPath(dir: string, name: string): string {
  return name === '' ? dir : dir.replace(/\/+$/, '') + '/' + name
}

export interface LoadSkillsOptions {
  readonly io: SkillFileIO
  readonly roots: readonly SkillRoot[]
  readonly limits?: SkillLoadLimits
}

export interface LoadedSkills {
  readonly skills: readonly SkillIndexEntry[]
  /** 人读的说明：哪个根目录不存在、哪个技能被跳过、哪条描述被截断 —— 如实进快照。 */
  readonly notices: readonly string[]
  /** 完整正文（按技能名索引）：S4b.3 读正文要用，索引里只放摘要。 */
  readonly bodies: ReadonlyMap<string, string>
}

/**
 * 扫描技能根目录（S4b.2）：每个子目录里的 `SKILL.md` 是一个技能。
 *
 * 三条纪律：
 * 1. **同名项目级覆盖用户级**（越具体越优先，与指令层同一个道理）；
 * 2. 根目录不存在不是错误（技能本来就是可选的）；但**技能文件写坏了要报错**（不静默跳过）；
 * 3. 超过上限时按名字排序截断，并**明确说明截断了什么**（不许静默丢）。
 */
export async function loadSkills(options: LoadSkillsOptions): Promise<LoadedSkills> {
  const limits = options.limits ?? DEFAULT_SKILL_LIMITS
  const notices: string[] = []
  const byName = new Map<string, SkillIndexEntry>()
  const bodies = new Map<string, string>()

  for (const root of options.roots) {
    let entries: readonly string[]
    try {
      entries = await options.io.readDir(root.dir)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/ENOENT|no such file|not found/i.test(message)) continue
      notices.push('读取技能目录失败 ' + root.dir + '：' + message)
      continue
    }
    for (const entry of [...entries].sort()) {
      if (!(await options.io.isDirectory(joinPath(root.dir, entry)))) continue
      const path = entry + '/SKILL.md'
      let text: string
      try {
        text = await options.io.readText(joinPath(root.dir, path))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/ENOENT|no such file|not found/i.test(message)) {
          notices.push('跳过 ' + root.source + ':' + entry + '（没有 SKILL.md）')
          continue
        }
        throw error
      }
      // 写坏了就报错：技能是给人看的知识，静默跳过会让人以为它生效了
      const parsed = parseSkillFrontmatter(text, root.source + ':' + path)
      const name = parsed.name ?? entry
      const attachmentCount = (await listAttachments(options.io, joinPath(root.dir, entry))).length
      byName.set(name, {
        name,
        description: parsed.description,
        ...(parsed.when === undefined ? {} : { when: parsed.when }),
        source: root.source,
        path,
        sha256: createHash('sha256').update(text).digest('hex'),
        attachmentCount,
      })
      bodies.set(name, text)
    }
  }

  const all = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
  if (all.length > limits.maxSkills) {
    notices.push('技能超过上限 ' + String(limits.maxSkills) + ' 个，已截断 ' + String(all.length - limits.maxSkills) + ' 个（按名字排序）')
  }
  const skills = all.slice(0, limits.maxSkills).map(entry => (
    entry.description.length <= limits.maxDescriptionChars
      ? entry
      : { ...entry, description: entry.description.slice(0, limits.maxDescriptionChars) + '…' }
  ))
  return { skills, notices, bodies }
}

/**
 * 渲染注入用的**索引**（一行一个技能）。没有技能时返回 undefined（提示词里不出现空标题）。
 */
export function renderSkillIndex(skills: readonly SkillIndexEntry[]): string | undefined {
  if (skills.length === 0) return undefined
  const lines = skills.map(skill =>
    '- ' + skill.name + ' —— ' + skill.description +
    (skill.when === undefined ? '' : ' | 何时用：' + skill.when) +
    (skill.attachmentCount === 0 ? '' : '（含 ' + String(skill.attachmentCount) + ' 个附件）'))
  return [
    '## 可用技能（索引）',
    '',
    '需要时用 read_skill 读取正文（只读你想用的那个；带附件的技能可以按相对路径读附件）。',
    '',
    ...lines,
  ].join('\n')
}

/**
 * 本机实现（app 用它读技能目录）。
 *
 * 放在包里而不是各 app 里复制：三个方法都要处理"路径不存在"的语义，
 * 复制三遍必然会漂。测试用假的 `SkillFileIO`，因此这层薄适配不被单测覆盖也没关系。
 */
export function nodeSkillIO(): SkillFileIO {
  return {
    async readText(path) {
      const { readFile } = await import('node:fs/promises')
      return await readFile(path, 'utf8')
    },
    async readDir(path) {
      const { readdir } = await import('node:fs/promises')
      return await readdir(path)
    },
    async isDirectory(path) {
      const { stat } = await import('node:fs/promises')
      try {
        return (await stat(path)).isDirectory()
      } catch {
        return false
      }
    },
    async realpath(path) {
      const { realpath } = await import('node:fs/promises')
      try {
        return await realpath(path)
      } catch {
        // 不存在就退回原路径：语法层已经拦过绝对路径与 .. ，这里只是再加一道真实路径检查
        return path
      }
    },
  }
}

/** 技能目录约定：用户级与项目级（项目级同名覆盖用户级）。 */
export const USER_SKILLS_DIRNAME = '.cubus/skills'
export const PROJECT_SKILLS_DIRNAME = '.cubus/skills'