import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
// 只从**包名**导入：这是"外部人视角"的验收 —— 公开面够不够用，这个文件说了算
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import { createTools } from '@cubus/tools'
import {
  collectMetrics,
  exportSessions,
  importSessions,
  listSessions,
  SessionRuntime,
} from '@cubus/sdk'
import type { AgentRecipe } from '@cubus/agent-recipe'

/**
 * 公开面验收（P1）：用一个"外部开发者"能拿到的全部东西，做出一个能跑的 agent 产品。
 *
 * 它同时钉住两件事：
 * 1. 公开 API 足够建产品（缺什么这里就会红）；
 * 2. 这个文件本身**不import 任何内部路径**（下面有一条自检），否则它就不是"外部视角"了。
 */

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('the test itself only reaches the public surface (no relative imports)', async () => {
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8')
  const relativeImports = source
    .split('\n')
    .filter(line => line.includes(' from '))
    .filter(line => /from '\.\.?\//.test(line))
  expect(relativeImports, 'this file must import by package name only').toEqual([])
})

test('a product built only on the public API can run, replay, measure and archive a session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-public-api-'))
  directories.push(root)
  const sessions = join(root, 'sessions')

  // 1) 一个产品 = recipe（提示词 + 工具 + 权限 + 预算）
  let idCounter = 0
  const recipe: AgentRecipe<void> = {
    manifest: {
      contractVersion: 1,
      id: 'public-api-sample',
      version: '1.0.0',
      displayName: 'Public API Sample',
      requires: [
        { kind: 'llm', features: ['tool-calling'] },
        { kind: 'session-log' },
        { kind: 'fs', features: ['read', 'write'] },
        { kind: 'subprocess' },
      ],
      prompt: { fragmentId: 'public-api-sample/role' },
      tools: ['read_file', 'edit_file', 'write_file', 'bash'],
      permission: { profile: 'allow' },
      budget: { maxSteps: 5, maxTokens: 10_000 },
    },
    async mount(ctx) {
      await ctx.plugin(systemPromptContribution({ id: 'public-api-sample/role', text: 'Sample agent.' }))
      const fs = ctx.get('fs')
      const subprocess = ctx.get('subprocess')
      const workspace = ctx.get('workspaceDir')
      if (!fs || !subprocess || !workspace) throw new Error('missing host capabilities')
      for (const tool of createTools(fs, subprocess, workspace)) {
        await ctx.plugin(toolContribution(tool))
      }
    },
  }

  // 2) 运行时 = host + recipe + app 级选项（这里只用到公开类型）
  const runtime = new SessionRuntime({
    rootDir: sessions,
    host: createLocalAgentHost({
      workspaceDir: root,
      adapterFactory: () => new ScriptedAdapter([
        { steps: [{ chunk: { delta: '第一步' } }, { chunk: { usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } } }] },
      ]),
    }),
    recipe,
    recipeOptions: undefined,
    retry: { maxAttempts: 2, sleep: async () => {} },
    generateId: () => 'public-' + String(++idCounter),
  })

  const session = await runtime.create()
  const run = await runtime.run(session.id, '做点什么')
  expect(run.assistantText).toBe('第一步')

  // 3) 观察：回放、装配快照、预算、并发
  const replay = await runtime.replay(session.id)
  expect(replay.events[0]?.type).toBe('session/mount')
  expect((await runtime.mountSnapshot(session.id))?.recipe.id).toBe('public-api-sample')
  expect((await runtime.mountSnapshot(session.id))?.budget).toEqual({ maxSteps: 5, maxTokens: 10_000 })
  expect(runtime.budgetState(session.id)?.tokens).toBe(12)
  expect(runtime.concurrency()).toMatchObject({ active: 0, queued: 0 })

  // 4) 列表 + 指标 + 归档：都在公开面上
  const summaries = await listSessions(sessions)
  expect(summaries.map(summary => summary.id)).toEqual([session.id])
  expect(summaries[0]?.formatVersion).toBe(3)

  const metrics = await collectMetrics(sessions)
  expect(metrics.totals).toMatchObject({ turns: 1, steps: 1, tokens: { total: 12 } })

  const archiveDir = join(root, 'archive')
  await exportSessions({ sessionsDir: sessions, outDir: archiveDir })
  await rm(sessions, { recursive: true, force: true })
  const imported = await importSessions({ archiveDir, sessionsDir: sessions })
  expect(imported.imported).toEqual([session.id])
  expect((await collectMetrics(sessions)).totals.tokens.total).toBe(12)
})
