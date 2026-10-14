import type { Tool } from '@cubus/tool-registry'
import { capSkillText, READ_SKILL_TOOL } from './catalog.ts'
import type { SkillCatalog } from './catalog.ts'

function stringField(args: unknown, name: string): string {
  if (typeof args !== 'object' || args === null || !(name in args)) throw new Error('missing argument: ' + name)
  const value = (args as Record<string, unknown>)[name]
  if (typeof value !== 'string' || value.trim() === '') throw new Error('argument ' + name + ' must be a non-empty string')
  return value
}

function optionalString(args: unknown, name: string): string | undefined {
  if (typeof args !== 'object' || args === null || !(name in args)) return undefined
  const value = (args as Record<string, unknown>)[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error('argument ' + name + ' must be a string')
  return value
}

/**
 * `read_skill`：把索引里只有一行的技能**按需读进上下文**（S4b.3）。
 *
 * 与 `recall_memory` / `read_session_log` / MCP 的"先给名字、再取正文"是同一条设计。
 * 三条纪律：输出有上限、附件路径限制在技能目录内、找不到时**列出可用技能**让模型能自我纠正。
 */
export function createReadSkillTool(catalog: SkillCatalog): Tool {
  return {
    name: READ_SKILL_TOOL,
    description:
      'Read the full instructions of one skill from the index (or one of its attachments). ' +
      'Call this when a skill looks relevant to the task - the index only carries one line per skill. ' +
      'Output is capped; attachments are addressed relative to the skill directory.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill name as shown in the index, e.g. release' },
        file: { type: 'string', description: 'optional attachment path relative to the skill directory, e.g. templates/x.md' },
      },
      required: ['name'],
    },
    async execute(args): Promise<string> {
      const name = stringField(args, 'name')
      const file = optionalString(args, 'file')
      const raw = file === undefined || file === ''
        ? catalog.readBody(name)
        : await catalog.readAttachment(name, file)
      const capped = capSkillText(raw)
      const header = file === undefined || file === ''
        ? '技能 ' + name + ' 的正文：\n\n'
        : '技能 ' + name + ' 的附件 ' + file + '：\n\n'
      return header + capped.text
    },
  }
}