import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import { createTools } from '@cubus/tools'
import type { AgentRecipe } from '@cubus/agent-recipe'
import {
  applyPrune,
  ArchiveError,
  ARCHIVE_MANIFEST,
  exportSessions,
  importSessions,
  parseArchiveManifest,
  planPrune,
} from '../src/archive.ts'
import { collectMetrics } from '../src/metrics.ts'
import { SessionRuntime } from '../src/runner.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporary(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}

const testRecipe: AgentRecipe<void> = {
  manifest: {
    contractVersion: 1,
    id: 'archive-test',
    version: '1.0.0',
    displayName: 'Archive Test Agent',
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      { kind: 'fs', features: ['read', 'write'] },
      { kind: 'subprocess' },
    ],
    prompt: { fragmentId: 'archive-test/role' },
    tools: ['read_file', 'edit_file', 'write_file', 'bash'],
    permission: { profile: 'allow' },
  },
  async mount(ctx) {
    await ctx.plugin(systemPromptContribution({ id: 'archive-test/role', text: 'Archive test agent.' }))
    const fs = ctx.get('fs')
    const subprocess = ctx.get('subprocess')
    const workspace = ctx.get('workspaceDir')
    if (!fs || !subprocess || !workspace) throw new Error('missing host capabilities')
    for (const tool of createTools(fs, subprocess, workspace)) {
      await ctx.plugin(toolContribution(tool))
    }
  },
}

/** 造两个会话：一个正常闭合，一个崩在回合中间。 */
async function seedSessions(root: string): Promise<{ sessions: string; crashedId: string }> {
  const sessions = join(root, 'sessions')
  let counter = 0
  const runtime = new SessionRuntime({
    rootDir: sessions,
    host: createLocalAgentHost({
      workspaceDir: root,
      adapterFactory: () => new ScriptedAdapter([{ steps: [{ chunk: { delta: '完成' } }] }]),
    }),
    recipe: testRecipe,
    recipeOptions: undefined,
    generateId: () => 's' + String(++counter),
  })
  const first = await runtime.create()
  await runtime.run(first.id, '任务一')
  const second = await runtime.create()
  await runtime.run(second.id, '任务二')

  // 把第二个会话变成"崩溃现场"：去掉最后的 turn/end
  const logPath = join(sessions, second.id, 'session.jsonl')
  const raw = await readFile(logPath, 'utf8')
  await writeFile(logPath, raw.trim().split('\n').slice(0, -1).join('\n') + '\n', 'utf8')
  return { sessions, crashedId: second.id }
}

test('export -> delete -> import keeps metrics and the crashed session intact', async () => {
  const root = await temporary('cubus-archive-')
  const { sessions, crashedId } = await seedSessions(root)
  const before = await collectMetrics(sessions)

  const archiveDir = join(root, 'archive')
  const manifest = await exportSessions({ sessionsDir: sessions, outDir: archiveDir })
  expect(manifest.sessions.map(session => session.id)).toEqual(['s1', 's2'])
  expect(manifest.sessions[0]?.files.map(file => file.path).sort()).toEqual(['session.jsonl', 'session.meta.json'])
  expect(manifest.sessions[0]?.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true)

  // 删掉原会话（模拟换机器/误删），再导入
  await rm(sessions, { recursive: true, force: true })
  const result = await importSessions({ archiveDir, sessionsDir: sessions })
  expect([...result.imported].sort()).toEqual(['s1', 's2'])
  expect(result.skipped).toEqual([])

  // 指标与崩溃现场都还原了（数据完整性可验证）
  const after = await collectMetrics(sessions)
  expect(after.totals).toEqual(before.totals)
  expect(after.sessions.map(session => session.sessionId).sort()).toEqual(['s1', 's2'])
  const crashed = after.sessions.find(session => session.sessionId === crashedId)
  expect(crashed?.needsSettlement).toBe(true)
})

test('a tampered archive is refused with a checksum error, and unknown files are refused outright', async () => {
  const root = await temporary('cubus-archive-')
  const { sessions } = await seedSessions(root)
  const archiveDir = join(root, 'archive')
  await exportSessions({ sessionsDir: sessions, outDir: archiveDir })

  // 改一个字节：导入必须拒绝，而不是悄悄导入坏数据
  const logPath = join(archiveDir, 'sessions', 's1', 'session.jsonl')
  const content = await readFile(logPath, 'utf8')
  await writeFile(logPath, content.replace('完成', '改过'), 'utf8')
  await expect(importSessions({ archiveDir, sessionsDir: join(root, 'target') }))
    .rejects.toThrow('checksum mismatch for s1/session.jsonl')

  // 归档里出现白名单之外的文件 -> 直接拒绝（防路径穿越）
  const manifestPath = join(archiveDir, ARCHIVE_MANIFEST)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { sessions: { files: { path: string }[] }[] }
  manifest.sessions[0]!.files.push({ path: '../../etc/passwd' })
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
  expect(() => parseArchiveManifest(JSON.stringify(manifest), 'manifest.json'))
    .toThrow('archive tries to import an unexpected file: "../../etc/passwd"')
})

test('import skips sessions that are already present, and renames when asked', async () => {
  const root = await temporary('cubus-archive-')
  const { sessions } = await seedSessions(root)
  const archiveDir = join(root, 'archive')
  await exportSessions({ sessionsDir: sessions, outDir: archiveDir })

  const samePlace = await importSessions({ archiveDir, sessionsDir: sessions })
  expect(samePlace.imported).toEqual([])
  expect(samePlace.skipped.map(entry => entry.id)).toEqual(['s1', 's2'])
  expect(samePlace.skipped[0]?.reason).toContain('already present')

  const renamed = await importSessions({ archiveDir, sessionsDir: sessions, rename: true })
  expect(renamed.imported).toEqual(['s1-imported-1', 's2-imported-1'])
})

test('a manifest with a newer format version or an unsafe id is refused', async () => {
  const root = await temporary('cubus-archive-')
  const { sessions } = await seedSessions(root)
  const target = join(root, 'target')

  const archiveDir = join(root, 'archive-newer')
  await exportSessions({ sessionsDir: sessions, outDir: archiveDir })
  const manifestPath = join(archiveDir, ARCHIVE_MANIFEST)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { sessions: { formatVersion: number }[] }
  manifest.sessions[0]!.formatVersion = 99
  await writeFile(manifestPath, JSON.stringify(manifest), 'utf8')
  const result = await importSessions({ archiveDir, sessionsDir: target })
  expect(result.imported).toEqual(['s2'])
  expect(result.skipped[0]?.reason).toContain('newer than this build supports')

  expect(() => parseArchiveManifest('{"version":1,"sessions":[{"id":"../evil","formatVersion":1,"files":[]}]}', 'm.json'))
    .toThrow('unsafe session id')
  expect(() => parseArchiveManifest('{"version":2,"sessions":[]}', 'm.json'))
    .toThrow('unsupported archive version 2')
  await expect(importSessions({ archiveDir: join(root, 'nope'), sessionsDir: target }))
    .rejects.toThrow('no manifest.json in')
})

test('prune keeps crashed sessions by default and only deletes what the plan lists', async () => {
  const root = await temporary('cubus-archive-')
  const { sessions, crashedId } = await seedSessions(root)

  // 默认：只删 30 天前的，且保留崩溃现场 -> 什么都不删
  const fresh = await planPrune({ sessionsDir: sessions })
  expect(fresh.remove).toEqual([])
  expect(fresh.keep.map(entry => entry.id).sort()).toEqual(['s1', crashedId].sort())

  // 把所有会话都当成"旧的"：崩溃会话仍然被保留
  const old = await planPrune({ sessionsDir: sessions, olderThanMs: -1 })
  expect(old.remove).toEqual(['s1'])
  expect(old.keep.some(entry => entry.id === crashedId && entry.reason.includes('needs settlement'))).toBe(true)

  const removed = await applyPrune({ sessionsDir: sessions, plan: old })
  expect(removed).toEqual(['s1'])
  await expect(readFile(join(sessions, 's1', 'session.jsonl'), 'utf8')).rejects.toThrow()
  await expect(readFile(join(sessions, crashedId, 'session.jsonl'), 'utf8')).resolves.toBeTruthy()

  // 明确要求删崩溃现场时也会进计划（调用方自己承担）
  const aggressive = await planPrune({ sessionsDir: sessions, olderThanMs: -1, keepNeedingSettlement: false })
  expect(aggressive.remove).toEqual([crashedId])

  await expect(applyPrune({ sessionsDir: sessions, plan: { remove: ['../etc'], keep: [] } }))
    .rejects.toThrow(ArchiveError)
})
