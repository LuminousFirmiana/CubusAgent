import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import {
  MemoryStore,
  MEMORY_INDEX_ORDER,
  nodeMemoryIO,
  renderMemoryIndex,
  withMemory,
} from '../src/index.ts'
import type { MemoryIO } from '../src/index.ts'

/** 内存版 IO：一个路径一份内容，够测存储的全部行为。 */
function memoryIO(initial: Record<string, string> = {}) {
  const files = { ...initial }
  let appends = 0
  const io: MemoryIO = {
    async read(path) {
      return files[path]
    },
    async append(path, text) {
      appends += 1
      files[path] = (files[path] ?? '') + text
    },
  }
  return { io, files, appends: () => appends }
}

const fixedClock = () => new Date('2026-10-13T08:00:00.000Z')

test('append assigns a readable id per day and list reads it back', async () => {
  const { io, files } = memoryIO()
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: fixedClock })

  const first = await store.append({ text: 'order 默认超时 2500ms', tags: ['order'] })
  const second = await store.append({ text: '分支叫 feature/cart-split' })

  expect(first.entry.id).toBe('m-2026-10-13-001')
  expect(second.entry.id).toBe('m-2026-10-13-002')
  expect(first.duplicate).toBe(false)
  const { entries, brokenLines } = await store.list()
  expect(entries).toHaveLength(2)
  expect(entries[0]?.tags).toEqual(['order'])
  expect(brokenLines).toBe(0)
  // 文件就是一行一条 JSON（人可以直接读、直接改）
  expect(files['/mem/memory.jsonl']?.trim().split('\n')).toHaveLength(2)
})

test('a duplicate is not written again (normalized comparison)', async () => {
  const { io, appends } = memoryIO()
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: fixedClock })
  await store.append({ text: 'order 默认超时 2500ms' })

  const again = await store.append({ text: '  Order   默认超时   2500ms ' })

  expect(again.duplicate).toBe(true)
  expect(again.entry.id).toBe('m-2026-10-13-001')
  expect(appends()).toBe(1)
})

test('an empty text is refused, and the next id continues from the day maximum', async () => {
  const { io } = memoryIO({ '/mem/memory.jsonl': '{"id":"m-2026-10-13-007","at":"2026-10-13T00:00:00.000Z","tags":[],"text":"早先的一条"}\n' })
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: fixedClock })

  await expect(store.append({ text: '   ' })).rejects.toThrow('must not be empty')
  const next = await store.append({ text: '新的一条' })
  expect(next.entry.id).toBe('m-2026-10-13-008')
})

test('broken lines are counted, not fatal: a hand-edited file still works', async () => {
  const { io } = memoryIO({
    '/mem/memory.jsonl': '{"id":"m-1","at":"2026-10-13T00:00:00.000Z","tags":[],"text":"好的"}\n这不是 JSON\n{"id":"m-2","text":"也好的"}\n',
  })
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: fixedClock })

  const { entries, brokenLines } = await store.list()
  expect(entries.map(entry => entry.text)).toEqual(['好的', '也好的'])
  expect(brokenLines).toBe(1)
})

test('recent returns newest first, capped', async () => {
  const { io } = memoryIO()
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: fixedClock })
  for (const text of ['一', '二', '三']) await store.append({ text })

  expect((await store.recent(2)).map(entry => entry.text)).toEqual(['三', '二'])
  expect((await store.recent(10)).map(entry => entry.text)).toEqual(['三', '二', '一'])
})

test('search is keyword based: more hits first, then newest', async () => {
  const { io } = memoryIO()
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: fixedClock })
  await store.append({ text: 'order 默认超时 2500ms', tags: ['order'] })
  await store.append({ text: 'order 模块负责人是林悦', tags: ['order', '人'] })
  await store.append({ text: '缓存前缀 cart:v2:' })

  const hits = await store.search('order 林悦', 5)
  expect(hits.map(entry => entry.text)).toEqual(['order 模块负责人是林悦', 'order 默认超时 2500ms'])
  expect(await store.search('找不到的词', 5)).toEqual([])
})

test('the index is one line per entry, clipped, and undefined when empty', () => {
  expect(renderMemoryIndex([])).toBeUndefined()

  const index = renderMemoryIndex([
    { id: 'm-2026-10-13-002', at: '2026-10-13T08:00:00.000Z', tags: ['order'], text: 'x'.repeat(300) },
    { id: 'm-2026-10-13-001', at: '2026-10-13T07:00:00.000Z', tags: [], text: '分支叫 feature/cart-split' },
  ], { limit: 12, maxLineChars: 40 })

  const lines = (index ?? '').split('\n')
  expect(index).toContain('recall_memory')          // 告诉模型正文怎么取
  expect(lines.filter(line => line.startsWith('- '))).toHaveLength(2)
  expect(lines.find(line => line.includes('x'))).toMatch(/…$/)   // 超长行被裁剪
  expect(index).toContain('[order]')                // 标签进索引
})

test('withMemory provides the store and injects the index; empty memory stays silent', async () => {
  const { io } = memoryIO()
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: fixedClock })
  await store.append({ text: 'order 默认超时 2500ms' })
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  const decorated = withMemory({ manifest: fakeManifest(), mount() {} }, { store })

  await decorated.mount(ctx, { memory: { path: '/mem/memory.jsonl', entries: 1, indexLimit: 12 } })

  expect(ctx.get('memoryStore')).toBe(store)
  const fragments = ctx.systemPrompt.list()
  expect(fragments.map(fragment => fragment.id)).toEqual(['memory.index'])
  expect(fragments[0]?.order).toBe(MEMORY_INDEX_ORDER)
  expect(ctx.systemPrompt.assemble() ?? '').toContain('order 默认超时 2500ms')

  // 空记忆：不注册片段（提示词里不该出现空标题）
  const empty = new Context()
  await empty.plugin(systemPromptPlugin)
  await withMemory({ manifest: fakeManifest(), mount() {} }, {
    store: new MemoryStore({ path: '/mem/empty.jsonl', io, now: fixedClock }),
  }).mount(empty, {})
  expect(empty.systemPrompt.list()).toEqual([])
})

test('the store survives a restart: a second store reads what the first wrote', async () => {
  const { io } = memoryIO()
  const first = new MemoryStore({ path: '/mem/memory.jsonl', io, now: fixedClock })
  await first.append({ text: '重启也要记得' })

  const second = new MemoryStore({ path: '/mem/memory.jsonl', io, now: fixedClock })
  expect((await second.recent(5)).map(entry => entry.text)).toEqual(['重启也要记得'])
  // nodeMemoryIO 只是把 IO 换成真文件，行为一致（这里只验证它符合接口）
  expect(typeof nodeMemoryIO().read).toBe('function')
})

function fakeManifest() {
  return {
    contractVersion: 1 as const, id: 'demo', version: '1.0.0', displayName: 'Demo', requires: [] as never[],
    prompt: { fragmentId: 'demo.role' }, tools: [] as never[], permission: { profile: 'ask' as const },
  }
}
