/**
 * 崩溃演示（D3 测试用）：跑一个会卡住的工具调用，然后一直等。
 *
 * 用法（由 test/resume.test.ts 启动）：
 *   CUBUS_CRASH_SESSIONS=<dir> CUBUS_CRASH_WORKSPACE=<dir>  *     node --import tsx/esm examples/crash-session.ts
 *
 * 启动后先打印 session 目录，再进入一次永远不结束的工具调用；
 * 测试看到日志里出现 tool/call 后直接 SIGKILL，模拟断电式崩溃。
 */
import { mkdtempSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentRecipe } from '@cubus/agent-recipe'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { systemPromptContribution } from '@cubus/system-prompt'
import { toolContribution } from '@cubus/tool-registry'
import { createTools } from '@cubus/tools'
import { SessionRuntime } from '../src/runner.ts'

const sessionsDir = process.env['CUBUS_CRASH_SESSIONS'] ?? mkdtempSync(join(tmpdir(), 'cubus-crash-'))
const workspaceDir = process.env['CUBUS_CRASH_WORKSPACE'] ?? mkdtempSync(join(tmpdir(), 'cubus-crash-ws-'))

// bash 工具需要 cwd 真实存在；否则调用会立刻失败、进程提前退出（那就不叫崩溃了）。
await mkdir(workspaceDir, { recursive: true })

const recipe: AgentRecipe<void> = {
  manifest: {
    contractVersion: 1,
    id: 'crash-demo',
    version: '1.0.0',
    displayName: 'Crash Demo',
    requires: [
      { kind: 'llm', features: ['tool-calling'] },
      { kind: 'session-log' },
      { kind: 'fs', features: ['read', 'write'] },
      { kind: 'subprocess' },
    ],
    prompt: { fragmentId: 'crash-demo/role' },
    tools: ['read_file', 'edit_file', 'write_file', 'bash'],
    permission: { profile: 'allow' },
  },
  async mount(ctx) {
    await ctx.plugin(systemPromptContribution({ id: 'crash-demo/role', text: 'Crash demo agent.' }))
    const fs = ctx.get('fs')
    const subprocess = ctx.get('subprocess')
    const workspace = ctx.get('workspaceDir')
    if (!fs || !subprocess || !workspace) throw new Error('missing host capabilities')
    for (const tool of createTools(fs, subprocess, workspace)) {
      await ctx.plugin(toolContribution(tool))
    }
  },
}

const runtime = new SessionRuntime({
  rootDir: sessionsDir,
  host: createLocalAgentHost({
    workspaceDir,
    adapterFactory: () => new ScriptedAdapter([
      { steps: [{ chunk: { toolCalls: [{ id: 'hang-1', name: 'bash', args: { command: 'sleep 5' } }] } }] },
    ]),
  }),
  recipe,
  recipeOptions: undefined,
  generateId: () => 'crash-session',
})

const session = await runtime.create()
// 测试靠这一行拿到会话目录
process.stdout.write('session-dir: ' + dirname(session.logPath) + '\n')
await runtime.run(session.id, 'run something that hangs')
