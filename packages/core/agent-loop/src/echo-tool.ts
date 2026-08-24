import type { Tool } from './types.ts'

/**
 * Echo 工具：把参数原样返回（JSON 字符串）。
 * 存在的意义是让"模型调工具 → 结果回喂 → 下一步"这条链在无外部世界时也能走通。
 */
export const echoTool: Tool = {
  name: 'echo',
  description: 'Echo back the given arguments as JSON. For testing the tool loop.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'any text to echo back' },
    },
    required: ['text'],
  },
  execute(args: unknown): string {
    return JSON.stringify(args)
  },
}
