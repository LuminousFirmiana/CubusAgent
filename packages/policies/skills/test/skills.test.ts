import { expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { systemPromptPlugin } from '@cubus/system-prompt'
import {
  loadSkills,
  parseSkillFrontmatter,
  renderSkillIndex,
  skillBody,
  SKILL_INDEX_ORDER,
  SkillFormatError,
  withSkills,
} from '../src/index.ts'
import type { SkillFileIO } from '../src/index.ts'

/** 内存文件系统：路径 → 内容；目录由路径前缀推出来。 */
function fakeIO(files: Record<string, string>): SkillFileIO {
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
      const content = files[path]
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
  }
}

const skill = (name: string, description: string, extra = ''): string =>
  '---\nname: ' + name + '\ndescription: ' + description + '\n---\n\n# ' + name + '\n\n步骤…\n' + extra

test('frontmatter accepts name, description and when; a missing description fails loudly', () => {
  expect(parseSkillFrontmatter('---\nname: a\ndescription: 做 A\nwhen: 需要 A 时\n---\n正文', 'a:SKILL.md'))
    .toEqual({ name: 'a', description: '做 A', when: '需要 A 时' })

  // 索引里没描述 = 模型无法判断该不该用 = 等于没写
  expect(() => parseSkillFrontmatter('---\nname: a\n---\n正文', 'a:SKILL.md')).toThrow('non-empty description')
  expect(() => parseSkillFrontmatter('正文', 'a:SKILL.md')).toThrow('missing frontmatter')
  expect(() => parseSkillFrontmatter('---\nname: a\ndescription: x\nowner: me\n---\n', 'a:SKILL.md')).toThrow('unknown frontmatter key')
  expect(() => parseSkillFrontmatter('---\nnot a pair\n---\n', 'a:SKILL.md')).toThrow('not "key: value"')
  expect(parseSkillFrontmatter('---\ndescription: x\n---\n', 'a:SKILL.md')).toEqual({ description: 'x' })
  expect(skillBody('---\nname: a\ndescription: x\n---\n正文')).toBe('正文')
})

test('the project scope wins over the user scope for the same skill name', async () => {
  const io = fakeIO({
    'user/release/SKILL.md': skill('release', '用户级发版流程'),
    'user/extra/SKILL.md': skill('extra', '只用用户级的技能'),
    'repo/.cubus/skills/release/SKILL.md': skill('release', '本仓库的发版流程'),
  })
  const loaded = await loadSkills({
    io,
    roots: [{ source: 'user', dir: 'user' }, { source: 'project', dir: 'repo/.cubus/skills' }],
  })

  const release = loaded.skills.find(entry => entry.name === 'release')
  expect(release?.source).toBe('project')
  expect(release?.description).toBe('本仓库的发版流程')
  expect(release?.path).toBe('release/SKILL.md')
  expect(release?.sha256).toHaveLength(64)
  expect(loaded.skills.map(entry => entry.name)).toEqual(['extra', 'release'])
})

test('attachments are counted (nested too) and a skill without SKILL.md is reported, not fatal', async () => {
  const io = fakeIO({
    'skills/pdf/SKILL.md': skill('pdf', '渲染 PDF'),
    'skills/pdf/templates/report.md': '模板',
    'skills/pdf/scripts/render.sh': '#!/bin/sh',
    'skills/broken/readme.txt': '没有 SKILL.md',
  })
  const loaded = await loadSkills({ io, roots: [{ source: 'user', dir: 'skills' }] })

  expect(loaded.skills.map(entry => entry.name)).toEqual(['pdf'])
  expect(loaded.skills[0]?.attachmentCount).toBe(2)
  expect(loaded.notices.join(' ')).toContain('没有 SKILL.md')
  // 正文按名字留在内存里，供 S4b.3 的 read_skill 用（索引里只有摘要）
  expect(loaded.bodies.get('pdf')).toContain('# pdf')
})

test('a broken skill file fails the load instead of being silently skipped', async () => {
  const io = fakeIO({ 'skills/bad/SKILL.md': '---\nname: bad\n---\n忘了写描述' })
  await expect(loadSkills({ io, roots: [{ source: 'user', dir: 'skills' }] })).rejects.toThrow(SkillFormatError)
})

test('the index is capped, truncation is announced, and long descriptions are clipped', async () => {
  const files: Record<string, string> = {}
  for (let index = 0; index < 5; index += 1) {
    files['skills/s' + String(index) + '/SKILL.md'] = skill('s' + String(index), '描述' + String(index) + 'x'.repeat(200))
  }
  const loaded = await loadSkills({
    io: fakeIO(files),
    roots: [{ source: 'user', dir: 'skills' }],
    limits: { maxSkills: 3, maxDescriptionChars: 20 },
  })

  expect(loaded.skills.map(entry => entry.name)).toEqual(['s0', 's1', 's2'])
  expect(loaded.notices.join(' ')).toContain('超过上限 3 个')
  expect(loaded.skills[0]?.description.endsWith('…')).toBe(true)
  expect(loaded.skills[0]?.description.length).toBe(21)
})

test('a missing skills root is normal, but an unreadable one is reported', async () => {
  const io = fakeIO({})
  const missing = await loadSkills({ io, roots: [{ source: 'user', dir: 'nope' }] })
  expect(missing.skills).toEqual([])
  expect(missing.notices).toEqual([])

  const failing = await loadSkills({
    io: { ...io, readDir: async () => { throw new Error('EACCES: permission denied') } },
    roots: [{ source: 'user', dir: 'skills' }],
  })
  expect(failing.notices.join(' ')).toContain('EACCES')
})

test('the rendered index is one line per skill and undefined when there are none', () => {
  expect(renderSkillIndex([])).toBeUndefined()
  const index = renderSkillIndex([
    { name: 'pdf', description: '渲染 PDF', when: '交付时', source: 'user', path: 'pdf/SKILL.md', sha256: 'x', attachmentCount: 2 },
    { name: 'release', description: '发版流程', source: 'project', path: 'release/SKILL.md', sha256: 'y', attachmentCount: 0 },
  ]) ?? ''
  expect(index).toContain('read_skill')
  expect(index.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2)
  expect(index).toContain('何时用：交付时')
  expect(index).toContain('含 2 个附件')
})

test('withSkills registers the index at order 400 and stays silent without skills', async () => {
  const io = fakeIO({ 'skills/pdf/SKILL.md': skill('pdf', '渲染 PDF') })
  const loaded = await loadSkills({ io, roots: [{ source: 'user', dir: 'skills' }] })
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  const decorated = withSkills({ manifest: fakeManifest(), mount() {} }, { skills: loaded.skills })

  await decorated.mount(ctx, { skills: loaded.skills, skillNotices: loaded.notices })
  const fragments = ctx.systemPrompt.list()
  expect(fragments.map(fragment => fragment.id)).toEqual(['skills.index'])
  expect(fragments[0]?.order).toBe(SKILL_INDEX_ORDER)
  expect(ctx.systemPrompt.assemble() ?? '').toContain('pdf')

  const empty = new Context()
  await empty.plugin(systemPromptPlugin)
  await withSkills({ manifest: fakeManifest(), mount() {} }, { skills: [] }).mount(empty, {})
  expect(empty.systemPrompt.list()).toEqual([])
})

function fakeManifest() {
  return {
    contractVersion: 1 as const, id: 'demo', version: '1.0.0', displayName: 'Demo', requires: [] as never[],
    prompt: { fragmentId: 'demo.role' }, tools: [] as never[], permission: { profile: 'ask' as const },
  }
}