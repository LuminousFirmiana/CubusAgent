import { createHash } from 'node:crypto'

/** 一个子 Agent 的定义（`.cubus/agents/<name>.md` 的 frontmatter）。 */
export interface SubagentDefinition {
  readonly name: string
  readonly description: string
  /** 收窄的工具白名单（缺省 = 产品默认工具面减去 spawn 能力）。 */
  readonly tools?: readonly string[]
  /** 是否默认在独立 worktree 里跑（缺省 true）。 */
  readonly isolation?: 'worktree' | 'shared'
  readonly path: string
  readonly sha256: string
}

export class SubagentDefinitionError extends Error {
  constructor(source: string, message: string) {
    super(source + ': ' + message)
    this.name = 'SubagentDefinitionError'
  }
}

const KNOWN_KEYS = ['name', 'description', 'tools', 'isolation']

/**
 * 解析定义文件的 frontmatter（最小子集，与技能同一套路：`key: value` 一行一条）。
 *
 * 三条纪律与技能一致：**未知键报错**、**缺 description 报错**、tools 用逗号分隔并去空白。
 * 为什么 description 必填：它要进父 Agent 的工具描述，父靠它判断"该派给谁"。
 */
export function parseSubagentDefinition(text: string, source: string): { name?: string; description: string; tools?: string[]; isolation?: 'worktree' | 'shared' } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (match === null) throw new SubagentDefinitionError(source, 'missing frontmatter: the file must start with a --- fenced block')
  const fields = new Map<string, string>()
  for (const line of (match[1] ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf(':')
    if (separator <= 0) throw new SubagentDefinitionError(source, 'frontmatter line is not "key: value": ' + trimmed)
    const key = trimmed.slice(0, separator).trim()
    if (!KNOWN_KEYS.includes(key)) {
      throw new SubagentDefinitionError(source, 'unknown frontmatter key "' + key + '" (known: name, description, tools, isolation)')
    }
    fields.set(key, trimmed.slice(separator + 1).trim())
  }
  const description = fields.get('description')
  if (description === undefined || description === '') {
    throw new SubagentDefinitionError(source, 'frontmatter must define a non-empty description (the parent agent picks who to delegate to by it)')
  }
  const name = fields.get('name')
  if (name !== undefined && name === '') throw new SubagentDefinitionError(source, 'frontmatter name must not be empty')
  const isolationField = fields.get('isolation')
  if (isolationField !== undefined && isolationField !== 'worktree' && isolationField !== 'shared') {
    throw new SubagentDefinitionError(source, 'isolation must be worktree or shared')
  }
  const toolsField = fields.get('tools')
  const tools = toolsField === undefined || toolsField === ''
    ? undefined
    : toolsField.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  return {
    ...(name === undefined ? {} : { name }),
    description,
    ...(tools === undefined ? {} : { tools }),
    ...(isolationField === undefined ? {} : { isolation: isolationField }),
  }
}

/** 正文（定义文件里 frontmatter 之后的说明）：将来喂给子 Agent 的角色提示词。 */
export function definitionBody(text: string): string {
  const match = /^---\n[\s\S]*?\n---\n?/.exec(text)
  return match === null ? text : text.slice(match[0].length)
}

export interface DefinitionFileIO {
  readonly readText: (path: string) => Promise<string>
  readonly readDir: (path: string) => Promise<readonly string[]>
  readonly isDirectory: (path: string) => Promise<boolean>
}

export interface LoadSubagentDefinitionsOptions {
  readonly io: DefinitionFileIO
  /** 定义目录（缺省 `<workspace>/.cubus/agents`）。 */
  readonly dir: string
}

/** 扫描定义目录：一个子目录一个定义（`<name>/AGENT.md`）或一个平铺文件（`<name>.md`）。 */
export async function loadSubagentDefinitions(options: LoadSubagentDefinitionsOptions): Promise<{ definitions: readonly SubagentDefinition[]; notices: readonly string[] }> {
  const notices: string[] = []
  let entries: readonly string[]
  try {
    entries = await options.io.readDir(options.dir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT|no such file|not found/i.test(message)) return { definitions: [], notices: [] }
    notices.push('读取子 Agent 定义目录失败 ' + options.dir + '：' + message)
    return { definitions: [], notices }
  }
  const definitions: SubagentDefinition[] = []
  for (const entry of [...entries].sort()) {
    const isDir = await options.io.isDirectory(options.dir + '/' + entry)
    const relative = isDir ? entry + '/AGENT.md' : entry
    if (!relative.endsWith('.md')) continue
    const path = options.dir + '/' + relative
    let text: string
    try {
      text = await options.io.readText(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/ENOENT|no such file|not found/i.test(message)) {
        notices.push('跳过 ' + entry + '（没有 AGENT.md）')
        continue
      }
      throw error
    }
    const parsed = parseSubagentDefinition(text, path)
    const fallback = isDir ? entry : entry.replace(/\.md$/, '')
    definitions.push({
      name: parsed.name ?? fallback,
      description: parsed.description,
      ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
      ...(parsed.isolation === undefined ? {} : { isolation: parsed.isolation }),
      path: relative,
      sha256: createHash('sha256').update(text).digest('hex'),
    })
  }
  return { definitions, notices }
}
