import type { AgentRecipe } from '@cubus/agent-recipe'
import type { Context } from '@cubus/cordis'
import type { SkillCatalog } from './catalog.ts'
import { renderSkillIndex } from './load.ts'
import type { SkillIndexEntry } from './load.ts'
import { READ_SKILL_TOOL } from './catalog.ts'
import { createReadSkillTool } from './tools.ts'

/** 技能索引在系统提示里的位置：角色 0 → 用户 100 → 项目 200 → 记忆 300 → **技能 400**。 */
export const SKILL_INDEX_ORDER = 400

export interface SkillsMountOptions {
  readonly skills?: readonly SkillIndexEntry[]
  /** 人读的加载说明（跳过/截断），只进快照给人看。 */
  readonly skillNotices?: readonly string[]
}

export interface SkillsPluginConfig {
  /** 已解析的技能索引（app 读完目录后传进来 —— 用户级技能在工作区之外）。 */
  readonly skills: readonly SkillIndexEntry[]
  /** 技能目录（提供时挂载 `read_skill`：模型按需读正文与附件）。 */
  readonly catalog?: SkillCatalog
}

/**
 * 技能插件（S4b.2）：把技能**索引**注册成系统提示片段。
 *
 * 与记忆同一个分工：**app 读文件、插件只渲染**（用户级技能在工作区之外，fs 能力按设计拒绝越界）。
 * 没有技能时不注册片段 —— 提示词里不出现空标题。
 */
export const skillsPlugin = {
  name: 'skills',
  inject: ['systemPrompt', 'tools'],
  apply(ctx: Context, config: SkillsPluginConfig) {
    // 有 catalog 才挂工具：没有正文可读时，声明一个只会报错的工具是噪声
    if (config.catalog !== undefined) ctx.tools.register(createReadSkillTool(config.catalog))
    const index = renderSkillIndex(config.skills)
    if (index === undefined) return
    ctx.systemPrompt.register({ id: 'skills.index', order: SKILL_INDEX_ORDER, text: index })
  },
}

/**
 * 给产品挂上技能索引（S4b.2）。装饰器放最外层：它要读 app 传进来的 `recipeOptions.skills`
 * （那份事实同时进装配快照 —— "这次有哪些技能可用"因此可审计）。
 */
export function withSkills<O extends object>(
  recipe: AgentRecipe<O>,
  config: SkillsPluginConfig,
): AgentRecipe<O & SkillsMountOptions>
export function withSkills(
  recipe: AgentRecipe<void>,
  config: SkillsPluginConfig,
): AgentRecipe<SkillsMountOptions>
export function withSkills(
  recipe: AgentRecipe<object> | AgentRecipe<void>,
  config: SkillsPluginConfig,
): AgentRecipe<SkillsMountOptions> {
  const inner = recipe as AgentRecipe<object>
  // 扩声明：提供 catalog 时 `read_skill` 会被注册，声明面必须同时列出它
  const declared = config.catalog === undefined
    ? recipe.manifest.tools
    : [...new Set([...recipe.manifest.tools, READ_SKILL_TOOL])].sort()
  return {
    manifest: { ...recipe.manifest, tools: declared },
    async mount(ctx: Context, options: SkillsMountOptions) {
      await inner.mount(ctx, options)
      await ctx.plugin(skillsPlugin, config)
    },
  }
}