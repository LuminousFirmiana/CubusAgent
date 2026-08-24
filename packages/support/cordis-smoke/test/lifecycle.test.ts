import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'

// 静音 logger（失败插件的测试会打印错误，测试里不需要）。
// level 未在公开类型上声明，用断言访问（仅测试代码里允许）。
function silent(ctx: Context) {
  ;(ctx.logger as unknown as { level: number }).level = -1
}

test('effects unwind in reverse registration order', async () => {
  const ctx = new Context()
  const order: string[] = []

  function myPlugin(ctx: Context) {
    ctx.effect(() => { order.push('+a'); return () => order.push('-a') })
    ctx.effect(() => { order.push('+b'); return () => order.push('-b') })
    ctx.effect(() => { order.push('+c'); return () => order.push('-c') })
  }

  const fiber = ctx.plugin(myPlugin)
  await fiber
  expect(order).toEqual(['+a', '+b', '+c'])

  await fiber.dispose()
  // 逆序回卷：先注册的后撤销 —— 乐高"拆件"的顺序保证
  expect(order).toEqual(['+a', '+b', '+c', '-c', '-b', '-a'])
})

test('disposing a plugin removes its services and event listeners (zero residue)', async () => {
  const ctx = new Context()
  const fired: string[] = []

  function myPlugin(ctx: Context) {
    ctx.provide('answer', 42)
    ctx.on('demo/log', () => fired.push('fired'))
  }

  const fiber = ctx.plugin(myPlugin)
  await fiber

  // 挂载后：服务在、事件监听有效
  expect(ctx.get('answer')).toBe(42)
  ctx.emit('demo/log', 'x')
  expect(fired).toEqual(['fired'])

  // 卸载：一个动作，全部回卷
  await fiber.dispose()

  // 零残留：服务没了，监听器不再触发
  expect(ctx.get('answer')).toBeUndefined()
  ctx.emit('demo/log', 'x')
  expect(fired).toEqual(['fired'])
})

test('a plugin with inject waits until its dependencies exist, then runs', async () => {
  const ctx = new Context()
  let applied = 0

  function waitingPlugin(ctx: Context) {
    applied++
    ctx.provide('double', ctx.get('counter') * 2)
  }

  // 声明依赖 'counter' —— 现在还没人提供它
  const fiber = ctx.plugin({ inject: ['counter'], apply: waitingPlugin })

  // 依赖未就绪：插件函数还没被执行
  expect(applied).toBe(0)

  // 依赖就绪：provide 会唤醒等待者，插件自动执行
  ctx.provide('counter', 21)
  await fiber

  expect(applied).toBe(1)
  expect(ctx.get('double')).toBe(42)
})

test('async effects are awaited and unwound on disposal', async () => {
  const ctx = new Context()
  const cleaned: string[] = []

  function myPlugin(ctx: Context) {
    // effect 本体是异步的：先 await，再返回 disposer
    ctx.effect(async () => {
      await new Promise(r => setTimeout(r, 5))
      return () => cleaned.push('async-cleaned')
    })
  }

  const fiber = ctx.plugin(myPlugin)
  await fiber           // 等插件加载完（异步 effect 已收集）
  await fiber.dispose() // 卸载时，异步 disposer 也被执行
  expect(cleaned).toEqual(['async-cleaned'])
})

test('a failing plugin enters FAILED state and is fully removable', async () => {
  const ctx = new Context()
  silent(ctx)

  function badPlugin() {
    throw new Error('boom')
  }

  const fiber = ctx.plugin(badPlugin)
  // await() 会抛出插件错误 —— 挂载失败以异常形式报告
  await expect(fiber.await()).rejects.toThrow('boom')
  expect(ctx.registry.has(badPlugin)).toBe(true)

  // 失败插件也能干净卸载
  await fiber.dispose()
  expect(ctx.registry.has(badPlugin)).toBe(false)
})
