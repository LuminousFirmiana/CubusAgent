import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ScriptedAdapter } from '@cubus/llm'
import { LocalSubprocess } from '@cubus/tools'
import { copyFixtureRepo, loadFixtures, scenesForFixture } from '../src/fixtures.ts'
import type { Fixture } from '../src/fixtures.ts'
import { runRepairTask } from '../src/harness.ts'

/**
 * 无 key 门禁：CI 每次 push 都跑，不联网、不花钱。
 *
 * 它验证三件事（不验证模型能力）：
 * 1. 每个 fixture 在修复前真的失败（bug 有效）；
 * 2. 参考修复能经由真实工具管道修好，并被判分测试认可（管道通）；
 * 3. 原件仓库在整套门禁跑完后仍然原样（不可变夹具）。
 */
const fixtures = await loadFixtures()
const subprocess = new LocalSubprocess()
const idleSignal = new AbortController().signal

/** 在 fixture 的临时副本上执行；原样仓库永不作为任务目标。 */
async function withCopy<T>(fixture: Fixture, run: (repoDir: string, scratchDir: string) => Promise<T>): Promise<T> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'cubus-fixture-'))
  try {
    const repoDir = join(scratchDir, 'repo')
    // 与 run.ts/golden.ts 同一个复制路径：排除评分元数据
    await copyFixtureRepo(fixture, repoDir)
    return await run(repoDir, scratchDir)
  } finally {
    await rm(scratchDir, { recursive: true, force: true })
  }
}

for (const fixture of fixtures) {
  test(fixture.spec.id + ': the fixture really fails before any fix', async () => {
    await withCopy(fixture, async repoDir => {
      const result = await subprocess.run(fixture.spec.testCommand, {
        cwd: repoDir,
        signal: idleSignal,
        timeoutMs: 30_000,
      })
      expect(result.exitCode).not.toBe(0)
    })
  })

  test(fixture.spec.id + ': the reference fix passes the judge (' + fixture.spec.bugKind + ')', async () => {
    const outcome = await withCopy(fixture, async (repoDir, scratchDir) => {
      return await runRepairTask({
        repoDir,
        sessionsDir: join(scratchDir, 'sessions'),
        adapterFactory: () => new ScriptedAdapter(scenesForFixture(fixture.spec)),
        testCommand: fixture.spec.testCommand,
        generateId: () => 'gate-' + fixture.spec.id,
      })
    })

    expect(outcome.passed).toBe(true)
    // 参考修复必须真的通过工具调用发生，而不是"空跑也过"。
    expect(outcome.turnEvents.filter(event => event.type === 'tool/call')).toHaveLength(
      fixture.spec.referenceFix.length,
    )
  })
}

test('the task workspace never contains the scoring metadata', async () => {
  // 参考修复与 golden 指纹是 harness 的东西：进了工作区就等于把答案交给 agent（评测失效）。
  // E5 期间真模型确实主动去读 fixture.json/golden.json，因此这里钉死。
  for (const fixture of fixtures) {
    await withCopy(fixture, async repoDir => {
      const entries = await readdir(repoDir)
      expect(entries, fixture.spec.id).not.toContain('fixture.json')
      expect(entries, fixture.spec.id).not.toContain('golden.json')
      // 仓库本体必须完整复制过来
      expect(entries, fixture.spec.id).toContain('package.json')
      expect(entries, fixture.spec.id).toContain('src')
      expect(entries, fixture.spec.id).toContain('test')
    })
  }
})

test(fixtures.length + ' fixtures stay pristine after the whole gate ran', async () => {
  expect(fixtures.length).toBeGreaterThanOrEqual(5)
  for (const fixture of fixtures) {
    // 直接跑原件：仍然失败 = 门禁跑的是副本，没有把原件修好。
    const result = await subprocess.run(fixture.spec.testCommand, {
      cwd: fixture.dir,
      signal: idleSignal,
      timeoutMs: 30_000,
    })
    expect(result.exitCode, fixture.spec.id + ' was mutated by the gate').not.toBe(0)
  }
})
