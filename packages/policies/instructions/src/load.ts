import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 一层指令在装配快照里的形状：**含全文** —— 日志必须能重建"当时给模型看了什么"。 */
export interface InstructionTier {
  readonly source: 'user' | 'project'
  /** 相对工作区的路径（用户层是绝对路径，本机路径不进仓库、但进日志便于审计）。 */
  readonly path: string
  readonly chars: number
  readonly sha256: string
  readonly truncated: boolean
  readonly text: string
}

export interface InstructionLimits {
  /** 单层字符上限。 */
  readonly perTier: number
  /** 所有层合计上限。 */
  readonly total: number
}

export const DEFAULT_INSTRUCTION_LIMITS: InstructionLimits = { perTier: 8_000, total: 16_000 }

/** 项目层按这个顺序找，找到第一个就用。 */
export const PROJECT_INSTRUCTION_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md']

export interface LoadInstructionOptions {
  /** 读文件的注入点：app 传 node:fs（工作区外的用户层走它），测试传假的。 */
  readonly readText: (path: string) => Promise<string>
  readonly workspaceDir: string
  /** 用户层文件（一般为 ~/.cubus/instructions.md）；缺省则不加载用户层。 */
  readonly userPath?: string
  readonly limits?: InstructionLimits
}

export interface LoadedInstructions {
  readonly tiers: readonly InstructionTier[]
  /** 人读的说明：缺了哪个文件、哪层被截断、哪层读失败 —— 如实进快照，不静默。 */
  readonly notices: readonly string[]
}

/** 读文件但把"不存在"当成正常情况（可选层）。 */
async function readOptional(readText: (path: string) => Promise<string>, path: string): Promise<{ text?: string; notice?: string }> {
  try {
    return { text: await readText(path) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT|no such file|not found|read failed/i.test(message)) return {}
    return { notice: '读取失败 ' + path + '：' + message }
  }
}

/**
 * 加载指令层（S4.2）。**这一步在 app 里调**，结果随 `recipeOptions.instructions` 进装配快照：
 *
 * - 只有"读文件"是外部动作，其余（截断、哈希、排序、标注）都是纯函数，可测；
 * - 缺失的文件不是错误（指令层本来就是可选的）；
 * - 截断**显式标注**：宁可让模型知道"这里少了东西"，也不要静默丢。
 */
export async function loadInstructionTiers(options: LoadInstructionOptions): Promise<LoadedInstructions> {
  const limits = options.limits ?? DEFAULT_INSTRUCTION_LIMITS
  const notices: string[] = []
  const raw: { source: 'user' | 'project'; path: string; text: string }[] = []

  if (options.userPath !== undefined) {
    const user = await readOptional(options.readText, options.userPath)
    if (user.notice !== undefined) notices.push(user.notice)
    if (user.text !== undefined && user.text.trim() !== '') {
      raw.push({ source: 'user', path: options.userPath, text: user.text })
    } else if (user.text !== undefined) {
      notices.push('用户层为空：' + options.userPath)
    }
  }

  for (const name of PROJECT_INSTRUCTION_FILES) {
    const project = await readOptional(options.readText, join(options.workspaceDir, name))
    if (project.notice !== undefined) notices.push(project.notice)
    if (project.text !== undefined) {
      if (project.text.trim() === '') notices.push('项目层为空：' + name)
      else raw.push({ source: 'project', path: name, text: project.text })
      break
    }
  }

  let remaining = limits.total
  const tiers: InstructionTier[] = []
  for (const entry of raw) {
    const cap = Math.min(limits.perTier, remaining)
    if (cap <= 0) {
      notices.push('合计上限已用尽，跳过 ' + entry.path)
      continue
    }
    const truncated = entry.text.length > cap
    const text = truncated ? entry.text.slice(0, cap) : entry.text
    if (truncated) {
      notices.push(entry.path + ' 超过 ' + String(cap) + ' 字符，已截断（原文 ' + String(entry.text.length) + ' 字符）')
    }
    remaining -= text.length
    tiers.push({
      source: entry.source,
      path: entry.path,
      chars: text.length,
      sha256: createHash('sha256').update(entry.text).digest('hex'),
      truncated,
      text,
    })
  }

  return { tiers, notices }
}

/**
 * 渲染进系统提示的文本。
 *
 * 两层都明确写出**优先级**：项目层说"优先于上面"，因为它更具体（越靠近具体项目越具体）。
 */
export function renderInstructionTier(tier: InstructionTier): string {
  const title = tier.source === 'user' ? '用户偏好（user instructions）' : '项目约定（project instructions）'
  const tail = tier.truncated ? '\n\n（本文件过长，以上为截断后的内容；需要完整内容请直接读源文件。）' : ''
  const precedence = tier.source === 'project' ? '\n\n以下项目约定优先于上面的通用说明与用户偏好。' : ''
  return '## ' + title + '：' + tier.path + tail + precedence + '\n\n' + tier.text
}
