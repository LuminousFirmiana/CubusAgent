import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'

// 声明我们的演示事件（cordis 的类型化事件表：声明合并）
declare module '@cubus/cordis' {
  interface Events {
    'demo/log'(message: string): void
    'demo/waterfall'(value: number, next: () => number): number
    'demo/parallel'(value: number): Promise<void>
    'demo/serial'(value: number): string | undefined | Promise<string | undefined>
    'demo/bail'(value: number): string
  }
}

test('emit: all listeners run in order, return values are ignored', () => {
  const ctx = new Context()
  const seen: string[] = []

  ctx.on('demo/log', () => seen.push('first'))
  ctx.on('demo/log', () => seen.push('second'))

  ctx.emit('demo/log', 'hi')
  expect(seen).toEqual(['first', 'second'])

  // on() 返回 disposer：注销后不再被调用
  const dispose = ctx.on('demo/log', () => seen.push('third'))
  dispose()
  ctx.emit('demo/log', 'hi')
  expect(seen).toEqual(['first', 'second', 'first', 'second'])
})

test('waterfall: listeners wrap the chain, next() threads the value, no next() short-circuits', () => {
  const ctx = new Context()

  // 监听器1：收到 value，调 next() 拿到下游结果，再加工返回
  ctx.on('demo/waterfall', (value, next) => value + next())
  // 监听器2：不调 next() —— 从这里截断，下游全部不执行
  ctx.on('demo/waterfall', (value) => value * 10)
  // 监听器3：永远不会被调用（被上面截断）
  ctx.on('demo/waterfall', (value, next) => value + next())

  // 派发：1 是事件参数，() => 2 是"链末端的默认实现"
  // 执行链：监听器1 → 监听器2(截断) → 默认实现被跳过
  // 计算：1 + (1 * 10) = 11
  expect(ctx.waterfall('demo/waterfall', 1, () => 2)).toBe(11)
})

test('waterfall: with no listeners, the default handler runs', () => {
  const ctx = new Context()
  expect(ctx.waterfall('demo/waterfall', 1, () => 42)).toBe(42)
})

test('parallel: all listeners run concurrently, errors aggregate into AggregateError', async () => {
  const ctx = new Context()
  const finished: string[] = []

  ctx.on('demo/parallel', async () => {
    await new Promise(r => setTimeout(r, 10))
    finished.push('slow')
  })
  ctx.on('demo/parallel', async () => {
    finished.push('fast')
  })
  ctx.on('demo/parallel', async () => {
    throw new Error('boom')
  })

  // 两个成功、一个失败：整组以 AggregateError 失败，但两个成功者都执行完了
  await expect(ctx.parallel('demo/parallel', 1)).rejects.toBeInstanceOf(AggregateError)
  expect(finished).toEqual(['fast', 'slow'])
})

test('serial: runs one at a time, the first non-empty result wins and stops the chain', async () => {
  const ctx = new Context()
  const calls: string[] = []

  ctx.on('demo/serial', async (value) => {
    calls.push('a')
    return undefined // 只有 null/false/undefined 才算"没结果"（bail 判定），继续下一个
  })
  ctx.on('demo/serial', async (value) => {
    calls.push('b')
    return 'winner'
  })
  ctx.on('demo/serial', async (value) => {
    calls.push('c') // 永远不会执行
    return 'late'
  })

  const result = await ctx.serial('demo/serial', 1)
  expect(result).toBe('winner')
  expect(calls).toEqual(['a', 'b'])
})

test('bail: same as serial but does not await listeners', () => {
  const ctx = new Context()

  ctx.on('demo/bail', () => 'first non-empty')
  const result = ctx.bail('demo/bail', 1)
  expect(result).toBe('first non-empty')
})

test('prepend option: a prepend listener runs before earlier registrations', () => {
  const ctx = new Context()
  const order: string[] = []

  ctx.on('demo/log', () => order.push('normal'))
  ctx.on('demo/log', () => order.push('prepended'), { prepend: true })

  ctx.emit('demo/log', 'hi')
  expect(order).toEqual(['prepended', 'normal'])
})
