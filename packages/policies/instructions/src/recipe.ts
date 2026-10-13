import type { AgentRecipe } from '@cubus/agent-recipe'
import type { Context } from '@cubus/cordis'
import { renderInstructionTier } from './load.ts'
import type { InstructionTier } from './load.ts'

/**
 * 指令层的装配参数：**已解析好的层**（app 读完文件后传进来）。
 *
 * 为什么不在插件里读文件：项目层在工作区内、可以走 fs 能力，但用户层在工作区外
 * （`~/.cubus/instructions.md`）—— fs 能力按设计拒绝越界路径。让它按"app 读、插件渲染"分工，
 * 好处是：①快照里的文本就是模型看到的文本（同一份数据，没有第二次读取的竞态）；
 * ②插件是纯的，测试不需要文件系统。
 */
export interface InstructionsMountOptions {
  readonly instructions?: readonly InstructionTier[]
  /** 人读的加载说明（缺文件、截断…），只进快照给人看，不进提示词。 */
  readonly instructionNotices?: readonly string[]
}

/** 片段顺序：角色 0（产品自己注册）→ 用户 100 → 项目 200。顺序即优先级。 */
export const USER_INSTRUCTION_ORDER = 100
export const PROJECT_INSTRUCTION_ORDER = 200

/**
 * 把指令层挂成系统提示片段（S4.2）。
 *
 * 不扩声明、不加能力：它只往既有的 `SystemPromptService` 里注册片段。
 * 装配参数里没有 `instructions` 时它什么都不做（插件是透明的）。
 */
export function withInstructions<O extends object>(recipe: AgentRecipe<O>): AgentRecipe<O & InstructionsMountOptions>
/** 没有装配参数的链路（CLI：`AgentRecipe<void>`）—— 重载是为了让两种链路都能直接串起来。 */
export function withInstructions(recipe: AgentRecipe<void>): AgentRecipe<InstructionsMountOptions>
export function withInstructions(
  recipe: AgentRecipe<object> | AgentRecipe<void>,
): AgentRecipe<InstructionsMountOptions> {
  const inner = recipe as AgentRecipe<object>
  return {
    manifest: recipe.manifest,
    async mount(ctx: Context, options: InstructionsMountOptions) {
      await inner.mount(ctx, options)
      const tiers = options.instructions ?? []
      if (tiers.length === 0) return
      await ctx.plugin({
        name: 'instructions',
        inject: ['systemPrompt'],
        apply(scope: Context) {
          const disposers = tiers.map(tier => scope.systemPrompt.register({
            id: 'instructions.' + tier.source,
            order: tier.source === 'user' ? USER_INSTRUCTION_ORDER : PROJECT_INSTRUCTION_ORDER,
            text: renderInstructionTier(tier),
          }))
          return () => {
            for (const dispose of disposers) dispose()
          }
        },
      })
    },
  }
}