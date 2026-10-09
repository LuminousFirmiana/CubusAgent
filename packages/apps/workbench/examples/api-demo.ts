/**
 * 工作台 API 演示（E1）：起一个本地服务，用假模型跑一个会话。
 *   pnpm run workbench:demo
 * 然后用 curl / 浏览器按它打印的地址访问（端点清单见 GET /）。
 *
 * 真模型入口（带凭据与产品 recipe 的接线）在 E2 的 main.ts 里。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalAgentHost } from '@cubus/host-local'
import { ScriptedAdapter } from '@cubus/llm'
import { codingAgentRecipe } from '@cubus/recipe-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import { startWorkbenchServer } from '../src/server.ts'

const workspace = process.env['CUBUS_WORKBENCH_WORKSPACE'] ?? join(tmpdir(), 'cubus-workbench-workspace')
const sessions = process.env['CUBUS_WORKBENCH_SESSIONS'] ?? join(tmpdir(), 'cubus-workbench-sessions')
await mkdir(workspace, { recursive: true })
await mkdir(sessions, { recursive: true })
await writeFile(join(workspace, 'note.txt'), 'hello workbench\n', 'utf8')

const runtime = new SessionRuntime({
  rootDir: sessions,
  // 演示用静态审批：真模型入口必须由用户显式选择审批档（E2）
  host: withToolApprovalHost(
    createLocalAgentHost({
      workspaceDir: workspace,
      adapterFactory: () => new ScriptedAdapter([
        { steps: [{ chunk: { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'note.txt' } }] } }] },
        { steps: [{ chunk: { delta: '我看完了 note.txt。' } }] },
      ]),
    }),
    createStaticToolApproval('allow', 'workbench demo'),
  ),
  recipe: codingAgentRecipe,
  recipeOptions: undefined,
  permissionProfile: 'allow',
  generateId: () => 'demo-session',
})

const server = await startWorkbenchServer({ runtime }, { port: 0 })
console.log('workbench listening on ' + server.url)
console.log('sessions dir: ' + sessions)
console.log('workspace:    ' + workspace)
console.log('')
console.log('try:')
console.log('  curl -s -X POST ' + server.url + '/api/sessions')
console.log('  curl -sN ' + server.url + '/api/sessions/demo-session/events &')
console.log('  curl -s -X POST -H \'content-type: application/json\' \\')
console.log('    -d \'{"task":"看看 note.txt"}\' ' + server.url + '/api/sessions/demo-session/run')
