import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const repositoryRoot = join(import.meta.dirname, '..', '..', '..', '..')

/**
 * 交接文档的完整性守卫（S6.1 事故）。
 *
 * 事故：用"整份读出再写回"的方式改 docs/handover.md，而 read 工具对**超长行**的文件只返回了一部分
 * （163 行只读到 85 行），于是写回时把后半份文档（阅读清单、技术债、冻结报告）整段截掉了，
 * 而且没有任何测试发现 —— 直到下一次要往阅读清单里加条目才暴露。
 *
 * 这条测试只钉"结构在不在"，不钉内容细节：截断一定先破坏结构。
 */
test('docs/handover.md keeps its structure (a truncation would fail here)', () => {
  const content = readFileSync(join(repositoryRoot, 'docs', 'handover.md'), 'utf8')
  const lines = content.split('\n')
  // 结构：五个一级章节 + 阅读清单 + 状态总览里的产品阶段行
  expect(lines.length).toBeGreaterThan(140)
  expect(content).toContain('## 1. 这个项目是什么')
  expect(content).toContain('## 2. 当前状态总览')
  expect(content).toContain('## 3. 五分钟接手地图（按顺序读）')
  expect(content).toContain('## 4. 架构一页图')
  expect(content).toContain('## 5. 仓库布局与常用命令')
  expect(content).toContain('docs/design/subagents.md')
  expect(content).toContain('docs/design/skills.md')
  expect(content).toContain('AGENTS.md —— 工程纪律')
})

test('other long-form docs are not truncated either', () => {
  for (const doc of ['docs/design/subagents.md', 'docs/design/skills.md', 'docs/design/memory.md', 'docs/design/context-compaction.md']) {
    const content = readFileSync(join(repositoryRoot, doc), 'utf8')
    expect(content.split('\n').length, doc).toBeGreaterThan(40)
  }
})