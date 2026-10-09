import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { AgentRecipe } from '@cubus/agent-recipe'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { referenceAgentRecipe, REFERENCE_AGENT_PROMPT } from '@cubus/recipe-reference-agent'
import { CODING_AGENT_PROMPT, repairEvalRecipe } from '@cubus/recipe-repair-eval'
import {
  createMemoryTransport,
  createRunnerMethods,
  RpcServer,
  SessionRuntime,
} from '@cubus/sdk'
import type { JsonRpcError, JsonRpcSuccess } from '@cubus/sdk'
import { SessionLogFile } from '@cubus/session-jsonl'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'

let dir: string

type Scenes = ConstructorParameters<typeof ScriptedAdapter>[0]

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-recipes-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function rpc(
  transport: ReturnType<typeof createMemoryTransport>,
  method: string,
  params: Record<string, unknown> = {},
  id: number = 1,
): Promise<JsonRpcSuccess | JsonRpcError> {
  const startIndex = transport.responses.length
  transport.receive(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    for (let i = startIndex; i < transport.responses.length; i++) {
      const response = JSON.parse(transport.responses[i]!) as { id?: number }
      if (response.id === id) return response as JsonRpcSuccess | JsonRpcError
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`rpc timeout waiting for id ${id}`)
}

/**
 * 同一个 Runtime / Host / 协议路径跑任意 Recipe（B4 起 Recipe 不再接收 provider，
 * 环境能力全部来自 Host；两个产品共用同一套组装代码）。
 */
async function runRecipe(recipe: AgentRecipe<void>, scenes: Scenes) {
  const workspaceDir = join(dir, 'workspace')
  const runtime = new SessionRuntime({
    rootDir: join(dir, recipe.manifest.id),
    host: withToolApprovalHost(
      createLocalAgentHost({ workspaceDir, adapterFactory: () => new ScriptedAdapter(scenes) }),
      createStaticToolApproval('allow', 'recipe acceptance test'),
    ),
    recipe,
    recipeOptions: undefined,
    permissionProfile: 'allow',
    generateId: () => 'session',
  })
  const transport = createMemoryTransport()
  new RpcServer(transport, createRunnerMethods(runtime))

  const created = await rpc(transport, 'session.create') as JsonRpcSuccess
  const session = created.result as { id: string, logPath: string }
  const response = await rpc(transport, 'session.run', {
    sessionId: session.id,
    text: 'Run this product through the common protocol.',
  }, 2) as JsonRpcSuccess
  const { events } = await new SessionLogFile(session.logPath).read()
  return { response, events }
}

test('reference-agent completes a domain-neutral tool loop through the common JSON-RPC SDK', async () => {
  const { response, events } = await runRecipe(referenceAgentRecipe, [
    { steps: [{ chunk: { toolCalls: [{ id: 'add-1', name: 'add_numbers', args: { a: 2, b: 3 } }] } }] },
    { steps: [{ chunk: { delta: '5' } }] },
  ])

  expect((response.result as { assistantText?: string }).assistantText).toBe('5')
  expect(events.find(event => event.type === 'tool/result')).toMatchObject({
    type: 'tool/result',
    id: 'add-1',
    ok: true,
    output: { text: '5' },
  })
  const header = events.find(event => event.type === 'request/header')
  expect(header?.header.systemPrompt).toBe(REFERENCE_AGENT_PROMPT)
  expect(header?.header.tools?.map(tool => tool.name)).toEqual(['add_numbers'])
})

test('switching Recipe changes only prompt and tools on the same runtime and protocol path', async () => {
  const scenes: Scenes = [{ steps: [{ chunk: { delta: 'ready' } }] }]

  const reference = await runRecipe(referenceAgentRecipe, scenes)
  const repair = await runRecipe(repairEvalRecipe, scenes)

  // 事件序列完全一致（含装配快照）：换产品不改内核行为。
  expect(reference.events.map(event => event.type)).toEqual(repair.events.map(event => event.type))
  const referenceHeader = reference.events.find(event => event.type === 'request/header')
  const repairHeader = repair.events.find(event => event.type === 'request/header')
  expect(referenceHeader?.header.systemPrompt).toBe(REFERENCE_AGENT_PROMPT)
  expect(referenceHeader?.header.tools?.map(tool => tool.name)).toEqual(['add_numbers'])
  expect(repairHeader?.header.systemPrompt).toBe(CODING_AGENT_PROMPT)
  expect(repairHeader?.header.tools?.map(tool => tool.name)).toEqual([
    'bash',
    'edit_file',
    'read_file',
    'write_file',
  ])

  // 装配快照记录的是各自声明与协商结果：reference 只要两项能力，repair 要五项。
  const referenceMount = reference.events[0]
  const repairMount = repair.events[0]
  expect(referenceMount?.type === 'session/mount' ? referenceMount.mount.capabilities.map(c => c.kind) : []).toEqual([
    'llm',
    'sandbox',
    'session-log',
  ])
  expect(repairMount?.type === 'session/mount' ? repairMount.mount.capabilities.map(c => c.kind) : []).toEqual([
    'approval',
    'fs',
    'llm',
    'sandbox',
    'session-log',
    'subprocess',
  ])
  // C2：两个产品都如实记录了"本地没有隔离"。
  expect(referenceMount?.type === 'session/mount'
    ? referenceMount.mount.capabilities.find(c => c.kind === 'sandbox')?.provider
    : undefined).toBe('local-unconfined')
})
