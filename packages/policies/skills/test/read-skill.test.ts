import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import { toolRegistryPlugin } from '@cubus/tool-registry'
import {
  capSkillText,
  createReadSkillTool,
  isInside,
  loadSkills,
  normalizeRelative,
  READ_SKILL_MAX_CHARS,
  READ_SKILL_TOOL,
  SkillCatalog,
  SkillNotFoundError,
  SkillPathError,
  withSkills,
} from '../src/index.ts'
import type { SkillFileIO, SkillRoot } from '../src/index.ts'

function fakeIO(files: Record<string, string>, links: Record<string, string> = {}): SkillFileIO {
  const dirs = new Set<string>()
  for (const path of Object.keys(files)) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index += 1) dirs.add(parts.slice(0, index).join('/'))
  }
  const list = (path: string): string[] => {
    const prefix = path === '' ? '' : path + '/'
    return [...new Set([...Object.keys(files), ...dirs]
      .filter(candidate => candidate.startsWith(prefix) && candidate !== path)
      .map(candidate => candidate.slice(prefix.length).split('/')[0] ?? ''))]
      .filter(entry => entry !== '')
      .sort()
  }
  return {
    async readText(path) {
      const resolved = links[path] ?? path
      const content = files[resolved]
      if (content === undefined) throw new Error('ENOENT: no such file or directory, open ' + path)
      return content
    },
    async readDir(path) {
      if (path !== '' && !dirs.has(path) && !Object.keys(files).some(file => file.startsWith(path + '/'))) {
        throw new Error('ENOENT: no such file or directory, scandir ' + path)
      }
      return list(path)
    },
    async isDirectory(path) {
      return dirs.has(path)
    },
    async realpath(path) {
      return links[path] ?? path
    },
  }
}

const skillText = (name: string, description: string, body: string): string =>
  '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n' + body

const ROOTS: readonly SkillRoot[] = [{ source: 'user', dir: 'skills' }]

async function catalogWith(files: Record<string, string>, links: Record<string, string> = {}): Promise<SkillCatalog> {
  const io = fakeIO(files, links)
  const loaded = await loadSkills({ io, roots: ROOTS })
  return new SkillCatalog({ skills: loaded.skills, bodies: loaded.bodies, roots: ROOTS, io })
}

test('read_skill returns the body without the frontmatter', async () => {
  const catalog = await catalogWith({ 'skills/release/SKILL.md': skillText('release', '发版流程', '# 步骤\n1. 跑检查\n2. 打 tag') })
  const tool = createReadSkillTool(catalog)

  const answer = await tool.execute({ name: 'release' }, { signal: new AbortController().signal })
  expect(answer).toContain('技能 release 的正文')
  expect(answer).toContain('1. 跑检查')
  // frontmatter 是给索引用的元数据，不该再占正文的位置
  expect(answer).not.toContain('description:')
})

test('read_skill reads an attachment relative to the skill directory', async () => {
  const catalog = await catalogWith({
    'skills/release/SKILL.md': skillText('release', '发版流程', '正文'),
    'skills/release/templates/entry.md': '## vX.Y.Z',
  })
  const tool = createReadSkillTool(catalog)

  const answer = await tool.execute({ name: 'release', file: 'templates/entry.md' }, { signal: new AbortController().signal })
  expect(answer).toContain('附件 templates/entry.md')
  expect(answer).toContain('## vX.Y.Z')
})

test('attachment paths cannot escape the skill directory', async () => {
  const catalog = await catalogWith({
    'skills/release/SKILL.md': skillText('release', '发版流程', '正文'),
    'secrets.txt': '不该被读到',
  })

  await expect(catalog.readAttachment('release', '../secrets.txt')).rejects.toThrow(SkillPathError)
  await expect(catalog.readAttachment('release', '/etc/passwd')).rejects.toThrow('must be relative')
  await expect(catalog.readAttachment('release', 'a/../../secrets.txt')).rejects.toThrow('must not contain ".."')
  expect(() => normalizeRelative('  ')).toThrow('must not be empty')

  // 符号链接逃逸：路径语法上没问题，但真实路径在外面 —— realpath 那一层拦住
  const linked = await catalogWith(
    { 'skills/release/SKILL.md': skillText('release', '发版流程', '正文'), 'outside/secret.txt': '秘密' },
    { 'skills/release/link.txt': 'outside/secret.txt' },
  )
  await expect(linked.readAttachment('release', 'link.txt')).rejects.toThrow('resolves outside the skill directory')
})

test('an unknown skill name lists what does exist', async () => {
  const catalog = await catalogWith({
    'skills/a/SKILL.md': skillText('a', '技能 A', '正文'),
    'skills/b/SKILL.md': skillText('b', '技能 B', '正文'),
  })
  // readBody 是同步的：它读的是内存里的正文，没有 IO
  expect(() => catalog.readBody('nope')).toThrow(SkillNotFoundError)
  expect(() => catalog.readBody('nope')).toThrow('可用技能：a, b')
  // 附件是异步的（要读盘）
  await expect(catalog.readAttachment('nope', 'x.txt')).rejects.toThrow('可用技能：a, b')
})

test('output is capped with a loud notice instead of silently truncated', () => {
  const long = 'x'.repeat(READ_SKILL_MAX_CHARS + 500)
  const capped = capSkillText(long)
  expect(capped.truncated).toBe(true)
  expect(capped.text.length).toBeLessThan(long.length)
  expect(capped.text).toContain('已截断')
  const short = capSkillText('短')
  expect(short.truncated).toBe(false)
})

test('withSkills declares and mounts read_skill when a catalog is provided', async () => {
  const catalog = await catalogWith({ 'skills/release/SKILL.md': skillText('release', '发版流程', '正文') })
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
  const decorated = withSkills(product, { skills: catalog.list(), catalog })

  // 声明面被补齐（否则装配期校验会拦下 read_skill）
  expect(decorated.manifest.tools).toEqual([READ_SKILL_TOOL])
  await decorated.mount(ctx, { skills: catalog.list() })
  expect(ctx.tools.snapshot().map(tool => tool.name)).toEqual([READ_SKILL_TOOL])

  // 没有 catalog 时不声明、不注册（只会报错的工具是噪声）
  const bare = withSkills(product, { skills: catalog.list() })
  expect(bare.manifest.tools).toEqual([])
  const bareCtx = new Context()
  await bareCtx.plugin(systemPromptPlugin)
  await bareCtx.plugin(toolRegistryPlugin)
  await bare.mount(bareCtx, {})
  expect(bareCtx.tools.snapshot()).toEqual([])
})

test('isInside compares path boundaries, not string prefixes', () => {
  expect(isInside('/a/b', '/a/b/c')).toBe(true)
  expect(isInside('/a/b', '/a/b')).toBe(true)
  // /a/bc 不是 /a/b 的子路径（前缀字符串比较会误判，这正是要防的）
  expect(isInside('/a/b', '/a/bc')).toBe(false)
  expect(isInside('/a/b/', '/a/b/c')).toBe(true)
})