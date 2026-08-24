/**
 * 演示客户端：spawn 真实服务进程，走 stdio 协议完成 create -> run -> list。
 *
 * 运行：pnpm run demo
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const packageRoot = join(import.meta.dirname, '..')
const demoDir = mkdtempSync(join(tmpdir(), 'cubus-demo-client-'))

const child = spawn(
  process.execPath,
  ['--import', 'tsx/esm', 'examples/headless-server.ts'],
  {
    cwd: packageRoot,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CUBUS_DEMO_DIR: join(demoDir, 'sessions') },
  },
)

let seq = 0
const pending = new Map<number, (value: unknown) => void>()
const rl = createInterface({ input: child.stdout })
rl.on('line', line => {
  const message = JSON.parse(line) as { id: number }
  pending.get(message.id)?.(message)
})

function request(method: string, params: Record<string, unknown> = {}) {
  const id = ++seq
  return new Promise<unknown>(resolve => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function main() {
  const created = await request('session.create') as { result: { id: string; logPath: string } }
  console.log('会话已创建:', created.result.id)
  console.log('日志位置:', created.result.logPath)

  const first = await request('session.run', { sessionId: created.result.id, text: '你好' })
  console.log('第一轮回复:', (first as { result: { assistantText?: string } }).result.assistantText)

  const second = await request('session.run', { sessionId: created.result.id, text: '再来一轮' })
  console.log('第二轮回复:', (second as { result: { assistantText?: string } }).result.assistantText)

  const list = await request('session.list') as { result: { id: string }[] }
  console.log('会话列表:', list.result.map(s => s.id).join(', '))

  child.stdin.end()
  process.exit(0)
}

void main()

