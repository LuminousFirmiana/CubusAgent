import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'

// ① 合同：任何模型供应商都必须实现这个接口。
//    协议差异（各家 API 格式不同）由适配器内部吸收，消费方永远看不见。
interface LlmAdapter {
  provider: string
  complete(prompt: string): string
}

// ② 声明服务键：让 ctx.llm 有类型（crodiss 的类型化服务表）
declare module '@cubus/cordis' {
  interface Context {
    llm: LlmAdapter
  }
}

// ③ 消费方：一个"工具"插件。注意——它从不 import 任何具体供应商，
//    甚至不知道"模型"是谁，只是每次调用时按名字去取。
function toolsPlugin(ctx: Context) {
  ctx.provide('summarize', (text: string) => {
    const llm = ctx.get('llm') // 每次调用时动态取，而不是挂载时存快照
    return `[${llm!.provider}] ${llm!.complete('总结：' + text)}`
  })
}

test('swapping the provided adapter is enough to swap the implementation', async () => {
  const ctx = new Context()

  // 供应商 A 上线
  ctx.provide('llm', {
    provider: 'deepseek',
    complete: () => '我是 A 的回答',
  } satisfies LlmAdapter)
  await ctx.plugin(toolsPlugin)

  const summarize = ctx.get('summarize') as (text: string) => string
  expect(summarize('随便什么文本')).toBe('[deepseek] 我是 A 的回答')

  // 换供应商：只动这一行 —— 消费方零改动
  ctx.set('llm', {
    provider: 'other-vendor',
    complete: () => '我是 B 的回答',
  } satisfies LlmAdapter)

  expect(summarize('随便什么文本')).toBe('[other-vendor] 我是 B 的回答')
})
