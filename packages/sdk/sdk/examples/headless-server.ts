/**
 * Headless 服务端示例：在真实进程里组装内核，通过 stdio 提供 JSON-RPC。
 *
 * 运行（配合 demo.ts）：node --import tsx/esm examples/headless-server.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRecipe } from '@cubus/agent-recipe'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { createRunnerMethods, SessionRuntime } from '../src/runner.ts'
import { RpcServer } from '../src/server.ts'
import { createStdioTransport } from '../src/stdio.ts'

const rootDir = process.env['CUBUS_DEMO_DIR'] ?? mkdtempSync(join(tmpdir(), 'cubus-demo-'))
const demoRecipe: AgentRecipe<void> = {
  manifest: { id: 'headless-demo', version: '1.0.0', displayName: 'Headless Demo' },
  mount() {},
}

const runtime = new SessionRuntime({
  rootDir,
  host: createLocalAgentHost({
    adapterFactory: () => new ScriptedAdapter([
      { steps: [{ chunk: { delta: '你好！我是通过真实进程的 stdio 回答你的。' } }] },
      { steps: [{ chunk: { delta: '这是第二轮。' } }] },
    ]),
  }),
  recipe: demoRecipe,
  recipeOptions: undefined,
})

const transport = createStdioTransport()
new RpcServer(transport, createRunnerMethods(runtime))

// 提示走 stderr，stdout 只承载协议
process.stderr.write(`cubus headless server ready (rootDir: ${rootDir})\n`)
