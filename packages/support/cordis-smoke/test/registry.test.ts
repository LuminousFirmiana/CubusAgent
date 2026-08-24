import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'

// 声明合并：给 Context 接口"加一行"，于是 ctx.greeting 有了类型。
// 这正是 cordis 类型化事件的核心机制——服务键是可扩展的类型表。
declare module '@cubus/cordis' {
  interface Context {
    greeting: { hello(): string }
  }
}

test('provide registers a service, property access and get() retrieve it', async () => {
  // 1. 创建一个 Context —— 它是所有服务的"家"
  const ctx = new Context()

  // 2. 一个普通对象，想让它成为服务
  const greeting = { hello: () => 'world' }

  // 3. 注册：provide 返回一个 disposer（撤销注册用的函数），我们暂存起来
  const dispose = ctx.provide('greeting', greeting)

  // 4. 查找：两种方式等价 —— ctx.greeting（属性拦截）和 ctx.get('greeting')
  expect(ctx.greeting).toBe(greeting)
  expect(ctx.get('greeting')).toBe(greeting)
  expect(ctx.greeting.hello()).toBe('world')

  // 5. 撤销注册，服务消失
  dispose()
  expect(ctx.get('greeting')).toBeUndefined()
})

test('plugin mounts and contributes a service from inside', async () => {
  const ctx = new Context()

  // 插件 = 一个函数（或带 apply 方法的对象），在挂载时被调用，拿到 ctx
  function myPlugin(ctx: Context) {
    ctx.provide('answer', 42)
  }

  // 挂载：返回的 fiber 可以 await（等它加载完成）
  await ctx.plugin(myPlugin)

  // 插件内部注册的服务，现在对外可见
  expect(ctx.get('answer')).toBe(42)
})
