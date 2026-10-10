import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import { createTools } from '@cubus/tools'
import type { AgentRecipe } from '@cubus/agent-recipe'
import type { SessionEvent } from '@cubus/session'
import { collectMetrics, sessionMetrics, summarizeMetrics } from '../src/metrics.ts'
import { SessionRuntime } from '../src/runner.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const events: SessionEvent[] = [
  { type: 'session/mount', mount: {} as never },
  { type: 'turn/start', turnId: 't1', at: '2026-01-01T00:00:00.000Z' },
  { type: 'user/message', messageId: 'm1', content: [{ type: 'text', text: '修好测试' }] },
  { type: 'step/start', stepId: 's1', turnId: 't1' },
  { type: 'tool/call', id: 'c1', stepId: 's1', name: 'read_file', args: { path: 'a.ts' } },
  { type: 'tool/result', id: 'c1', ok: true, output: { text: '内容' } },
  { type: 'assistant/message', messageId: 'a1', stepId: 's1', content: [], usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cachedTokens: 64 } },
  { type: 'step/end', stepId: 's1' },
  // 一次瞬时失败后的重试（F4b：重试是请求事实，落盘可审计）
  { type: 'request/retry', stepId: 's1', attempt: 2, reason: 'network error' },
  { type: 'step/start', stepId: 's2', turnId: 't1' },
  { type: 'tool/call', id: 'c2', stepId: 's2', name: 'bash', args: { command: 'node --test' } },
  { type: 'tool/result', id: 'c2', ok: false, output: { text: 'tool denied by approval policy: bash (the user rejected this tool call)' } },
  { type: 'assistant/message', messageId: 'a2', stepId: 's2', content: [], usage: { promptTokens: 200, completionTokens: 20, totalTokens: 220 } },
  { type: 'step/end', stepId: 's2' },
  { type: 'turn/end', turnId: 't1', at: '2026-01-01T00:00:05.000Z' },
  { type: 'turn/start', turnId: 't2', at: '2026-01-01T00:01:00.000Z' },
  { type: 'step/start', stepId: 's3', turnId: 't2' },
  { type: 'assistant/message', messageId: 'a3', stepId: 's3', content: [{ type: 'text', text: '部分' }], interrupted: true },
  { type: 'step/end', stepId: 's3' },
  // 恢复结算的回合：这段间隔是"崩溃到重启"，不该算成一个回合的耗时
  { type: 'turn/end', turnId: 't2', settled: true, at: '2026-01-01T03:00:00.000Z' },
]

test('session metrics count turns, tools, denials and tokens straight from the log', () => {
  const metrics = sessionMetrics('s1', events)

  expect(metrics).toMatchObject({
    events: 20,
    turns: 2,
    cancelledTurns: 1,
    settledTurns: 1,
    steps: 3,
    toolCalls: 2,
    toolFailures: 1,
    toolDenials: 1,
    usageMessages: 2,
    needsSettlement: false,
  })
  expect(metrics.toolCallsByName).toEqual({ read_file: 1, bash: 1 })
  expect(metrics.tokens).toEqual({ prompt: 300, completion: 30, total: 330, cached: 64 })
  // F4b：重试次数 + 回合耗时（只算正常闭合、两端都有时间戳的回合；结算回合不计）
  expect(metrics.retries).toBe(1)
  expect(metrics.durationMs).toEqual({ turns: 1, total: 5_000, max: 5_000 })
})

test('an unclosed turn is reported as needing settlement, and rates stay null without data', () => {
  const crashed = sessionMetrics('crashed', events.slice(0, 5))
  expect(crashed.needsSettlement).toBe(true)
  expect(crashed.turns).toBe(1)
  expect(crashed.toolDenials).toBe(0)

  const summary = summarizeMetrics([crashed])
  expect(summary.totals.toolCalls).toBe(1)
  expect(summary.totals.toolDenials).toBe(0)
  // 没有分母 -> null（"没有数据"），不是 0（会被误读成"确实没发生"）
  expect(summary.rates.toolDenial).toBe(0)
  expect(summarizeMetrics([]).rates.toolFailure).toBeNull()
  expect(summarizeMetrics([]).rates.tokensPerUsageMessage).toBeNull()

  const withData = summarizeMetrics([sessionMetrics('s1', events)])
  expect(withData.rates.toolDenial).toBeCloseTo(0.5)
  expect(withData.rates.turnCancellation).toBeCloseTo(0.5)
  expect(withData.rates.tokensPerUsageMessage).toBe(165)
  expect(withData.rates.retry).toBeCloseTo(1 / 3)
  expect(withData.rates.turnDurationMs).toBe(5_000)
  expect(withData.totals.retries).toBe(1)
  expect(summarizeMetrics([]).rates.turnDurationMs).toBeNull()
  expect(withData.totals.toolCallsByName).toEqual({ read_file: 1, bash: 1 })
})

const testRecipe: AgentRecipe<void> = {
  manifest: {
    contractVersion: 1,
    id: 'metrics-test',
    version: '1.0.0',
    displayName: 'Metrics Test Agent',
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      { kind: 'fs', features: ['read', 'write'] },
      { kind: 'subprocess' },
    ],
    prompt: { fragmentId: 'metrics-test/role' },
    tools: ['read_file', 'edit_file', 'write_file', 'bash'],
    permission: { profile: 'allow' },
  },
  async mount(ctx) {
    await ctx.plugin(systemPromptContribution({ id: 'metrics-test/role', text: 'Metrics test agent.' }))
    const fs = ctx.get('fs')
    const subprocess = ctx.get('subprocess')
    const workspace = ctx.get('workspaceDir')
    if (!fs || !subprocess || !workspace) throw new Error('missing host capabilities')
    for (const tool of createTools(fs, subprocess, workspace)) {
      await ctx.plugin(toolContribution(tool))
    }
  },
}

test('collectMetrics reads real session directories, including a crashed one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cubus-metrics-'))
  directories.push(root)
  const sessions = join(root, 'sessions')
  let counter = 0
  const runtime = new SessionRuntime({
    rootDir: sessions,
    host: createLocalAgentHost({
      workspaceDir: root,
      adapterFactory: () => new ScriptedAdapter([
        { steps: [{ chunk: { delta: '完成' } }] },
      ]),
    }),
    recipe: testRecipe,
    recipeOptions: undefined,
    generateId: () => 'm' + String(++counter),
  })

  const first = await runtime.create()
  await runtime.run(first.id, '任务一')
  const second = await runtime.create()
  await runtime.run(second.id, '任务二')

  const summary = await collectMetrics(sessions)
  expect(summary.totals.sessions).toBe(2)
  expect(summary.totals.turns).toBe(2)
  expect(summary.totals.steps).toBe(2)
  expect(summary.sessions.map(session => session.sessionId).sort()).toEqual(['m1', 'm2'])
  // 假模型没有 usage：token 是 0，而比率保持 null 语义（这里工具调用为 0）
  expect(summary.totals.tokens.total).toBe(0)
  expect(summary.rates.toolDenial).toBeNull()
})
