import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'

let dir: string
let child: ReturnType<typeof spawn> | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-e2e-'))
})

afterEach(async () => {
  child?.kill()
  child = undefined
  await rm(dir, { recursive: true, force: true })
})

test('a real child process serves the kernel over stdio', async () => {
  const packageRoot = join(import.meta.dirname, '..')
  child = spawn(
    process.execPath,
    ['--import', 'tsx/esm', 'examples/headless-server.ts'],
    {
      cwd: packageRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CUBUS_DEMO_DIR: join(dir, 'sessions') },
    },
  )

  const childOut = child.stdout
  const childIn = child.stdin
  if (!childOut || !childIn) throw new Error('failed to spawn child')

  let seq = 0
  const pending = new Map<number, (value: unknown) => void>()
  const rl = createInterface({ input: childOut })
  rl.on('line', line => {
    const message = JSON.parse(line) as { id: number }
    pending.get(message.id)?.(message)
  })

  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++seq
    return new Promise<unknown>(resolve => {
      pending.set(id, resolve)
      childIn.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  const created = await request('session.create') as { result: { id: string } }
  expect(created.result.id).toBeTruthy()

  const first = await request('session.run', { sessionId: created.result.id, text: '你好' })
  expect((first as { result: { assistantText?: string } }).result.assistantText).toContain('stdio')

  const second = await request('session.run', { sessionId: created.result.id, text: '再来一轮' })
  expect((second as { result: { assistantText?: string } }).result.assistantText).toContain('第二轮')

  const list = await request('session.list') as { result: { id: string }[] }
  expect(list.result.map(s => s.id)).toEqual([created.result.id])

  childIn.end()
})

