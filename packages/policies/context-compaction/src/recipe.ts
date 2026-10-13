import type { AgentRecipe } from '@cubus/agent-recipe'
import type { Context } from '@cubus/cordis'
import { createReadSessionLogTool, READ_SESSION_LOG_TOOL } from './tools.ts'

/**
 * 给产品接上"读回被压缩内容"的工具（S3.2）。
 *
 * 和 MCP 的装饰器同一个套路：**扩声明**（把工具名加进 manifest.tools）+ **挂载**（inject 两个服务后
 * 把工具注册进注册表）。产品自己的 manifest 与 mount 不改。
 */
export function withSessionLogTools(recipe: AgentRecipe<void>): AgentRecipe<void> {
  const declared = [...new Set([...recipe.manifest.tools, READ_SESSION_LOG_TOOL])].sort()
  return {
    manifest: { ...recipe.manifest, tools: declared },
    async mount(ctx: Context, options: void) {
      await recipe.mount(ctx, options)
      await ctx.plugin({
        name: 'tool:' + READ_SESSION_LOG_TOOL,
        // 读日志 + 注册工具：两个服务都要显式 inject（cordis 的访问纪律）
        inject: ['sessionLog', 'tools'],
        apply(scope: Context) {
          return scope.tools.register(createReadSessionLogTool(scope.sessionLog))
        },
      })
    },
  }
}
