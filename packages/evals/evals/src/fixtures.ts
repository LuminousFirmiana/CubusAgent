import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Scene } from '@cubus/llm'

/** 一个修复任务 fixture 的自描述（fixture.json）。 */
export interface FixtureSpec {
  id: string
  title: string
  /** bug 类型（分数表按它分类）：logic/boundary/missing-branch/type-coercion/async/side-effect/error-handling。 */
  bugKind: string
  /** 判分命令：在 fixture 的临时副本里执行。 */
  testCommand: string
  /**
   * 参考修复：按顺序的工具调用。
   * 只用于无 key 门禁 —— 回放一个已知正确的修复，证明"夹具是坏的、管道能修、判分能认"，
   * 不代表任何模型能力。
   */
  referenceFix: { tool: string; args: Record<string, unknown> }[]
}

export interface Fixture {
  spec: FixtureSpec
  /** fixture 原样仓库目录；任务永远只跑它的临时副本，原样保持不变。 */
  dir: string
}

/** fixture 原样仓库根目录。 */
export function fixturesRoot(): string {
  return join(import.meta.dirname, '..', 'fixtures', 'bug-repos')
}

/** 读取全部 fixture，按 id 排序（确定性）。 */
export async function loadFixtures(): Promise<Fixture[]> {
  const root = fixturesRoot()
  const entries = await readdir(root, { withFileTypes: true })
  const fixtures: Fixture[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(root, entry.name)
    const spec = JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8')) as FixtureSpec
    if (spec.id !== entry.name) {
      throw new Error('fixture id does not match its directory: ' + entry.name)
    }
    fixtures.push({ spec, dir })
  }
  fixtures.sort((left, right) => (left.spec.id < right.spec.id ? -1 : left.spec.id > right.spec.id ? 1 : 0))
  return fixtures
}

/** 把参考修复翻译成假模型场景：每个工具调用一个 step，最后收一句报告。 */
export function scenesForFixture(spec: FixtureSpec): Scene[] {
  const scenes: Scene[] = spec.referenceFix.map((call, index) => ({
    steps: [{
      chunk: {
        toolCalls: [{ id: spec.id + '-fix-' + String(index + 1), name: call.tool, args: call.args }],
      },
    }],
  }))
  scenes.push({ steps: [{ chunk: { delta: '已按参考修复处理：' + spec.title } }] })
  return scenes
}
