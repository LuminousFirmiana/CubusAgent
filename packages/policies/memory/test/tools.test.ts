import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import {
  createRecallMemoryTool,
  createRememberMemoryTool,
  MemoryStore,
  RECALL_MEMORY_TOOL,
  REMEMBER_MEMORY_TOOL,
  withMemory,
} from '../src/index.ts'
import type { MemoryIO } from '../src/index.ts'

function memoryIO(initial: Record<string, string> = {}) {
  const files = { ...initial }
  return {
    io: {
      async read(path: string) { return files[path] },
      async append(path: string, text: string) { files[path] = (files[path] ?? '') + text },
    } satisfies MemoryIO,
    files,
  }
}

const clock = () => new Date('2026-10-13T08:00:00.000Z')
const signal = new AbortController().signal

async function seed(lines: string[]): Promise<MemoryStore> {
  const { io } = memoryIO()
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: clock })
  for (const text of lines) await store.append({ text })
  return store
}

test('recall by id returns the full text the index only hinted at', async () => {
  const store = await seed(['order 默认超时 2500ms'])
  const tool = createRecallMemoryTool(store)

  const answer = await tool.execute({ id: 'm-2026-10-13-001' }, { signal })
  expect(answer).toContain('m-2026-10-13-001')
  expect(answer).toContain('order 默认超时 2500ms')
})

test('recall by id for an unknown entry suggests what exists instead of failing', async () => {
  const store = await seed(['唯一的一条'])
  const tool = createRecallMemoryTool(store)

  const answer = await tool.execute({ id: 'm-1970-01-01-001' }, { signal })
  expect(answer).toContain('没有 id')
  expect(answer).toContain('m-2026-10-13-001')   // 给出最近的 id，模型可以接着查
})

test('recall by query searches text and tags, and says so when nothing matches', async () => {
  const { io } = memoryIO()
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: clock })
  await store.append({ text: 'order 默认超时 2500ms', tags: ['order'] })
  await store.append({ text: '发布窗口固定在周四', tags: ['发布'] })
  const tool = createRecallMemoryTool(store)

  const hits = await tool.execute({ query: '发布' }, { signal })
  expect(hits).toContain('发布窗口固定在周四')
  expect(hits).not.toContain('2500ms')

  const miss = await tool.execute({ query: '完全不存在的词' }, { signal })
  expect(miss).toContain('没有匹配')
  expect(miss).toContain('2 条')          // 告诉模型记忆里总共有什么规模
})

test('recall output is capped: a huge memory cannot blow the window through recall', async () => {
  const store = await seed(['x'.repeat(30_000), 'y'.repeat(30_000)])
  const tool = createRecallMemoryTool(store)

  const answer = await tool.execute({ query: 'x y', limit: 10 }, { signal })
  expect(answer.length).toBeLessThan(9_000)
  expect(answer).toContain('长度上限')
})

test('recall validates arguments instead of guessing', async () => {
  const tool = createRecallMemoryTool(await seed(['一条']))
  await expect(tool.execute({}, { signal })).rejects.toThrow('missing argument: query')
  await expect(tool.execute({ id: '   ' }, { signal })).rejects.toThrow('non-empty string')
  await expect(tool.execute({ query: 'a', limit: 0 }, { signal })).rejects.toThrow('positive integer')
})

test('remember writes a new entry, then reports the duplicate without writing again', async () => {
  const { io, files } = memoryIO()
  const store = new MemoryStore({ path: '/mem/memory.jsonl', io, now: clock })
  const tool = createRememberMemoryTool(store)

  const first = await tool.execute({ text: '回调签名改成 (err, value)', tags: ['api'] }, { signal })
  expect(first).toContain('已记住 m-2026-10-13-001')
  expect(files['/mem/memory.jsonl']?.split('\n').filter(Boolean)).toHaveLength(1)

  const again = await tool.execute({ text: '回调签名改成   (err, value)' }, { signal })
  expect(again).toContain('已经存在')
  expect(files['/mem/memory.jsonl']?.split('\n').filter(Boolean)).toHaveLength(1)

  await expect(tool.execute({ text: '  ' }, { signal })).rejects.toThrow('non-empty string')
})

test('withMemory declares both tools and registers them next to the index', async () => {
  const store = await seed(['order 默认超时 2500ms'])
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolRegistryPlugin)
  const product = {
    manifest: {
      contractVersion: 1 as const, id: 'demo', version: '1.0.0', displayName: 'Demo', requires: [] as never[],
      prompt: { fragmentId: 'demo.role' }, tools: [] as string[], permission: { profile: 'ask' as const },
    },
    mount() {},
  }
  const decorated = withMemory(product, { store })

  // 声明面被补齐（否则装配期校验会拦下这两个工具）
  expect(decorated.manifest.tools).toEqual([RECALL_MEMORY_TOOL, REMEMBER_MEMORY_TOOL])

  await decorated.mount(ctx, { memory: { path: '/mem/memory.jsonl', entries: 1, indexLimit: 12 } })
  const names = ctx.tools.snapshot().map(tool => tool.name).sort()
  expect(names).toEqual([RECALL_MEMORY_TOOL, REMEMBER_MEMORY_TOOL])
  expect(ctx.get('memoryStore')).toBe(store)
})