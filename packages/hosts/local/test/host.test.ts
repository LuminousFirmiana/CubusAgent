import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import type { LlmAdapter } from '@cubus/llm'
import { SessionLogFile } from '@cubus/session-jsonl'
import { createLocalAgentHost } from '../src/index.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('creates one adapter and JSONL provider per session and rolls both back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cubus-local-host-'))
  directories.push(directory)
  const adapter: LlmAdapter = {
    provider: 'local-test',
    model: 'scripted',
    async *stream() {},
  }
  let factoryCalls = 0
  const host = createLocalAgentHost({
    workspaceDir: directory,
    adapterFactory() {
      factoryCalls += 1
      return adapter
    },
  })
  const ctx = new Context()
  const logPath = join(directory, 'session.jsonl')
  const hostFiber = ctx.plugin({
    name: 'test-host',
    apply(hostContext: Context) {
      return host.mount(hostContext, { id: 's1', directory, logPath })
    },
  })
  await hostFiber

  expect(factoryCalls).toBe(1)
  expect(ctx.get('llm')).toBe(adapter)
  expect(ctx.get('sessionLog')).toBeInstanceOf(SessionLogFile)
  expect((ctx.get('sessionLog') as SessionLogFile).path).toBe(logPath)

  await hostFiber.dispose()
  expect(ctx.get('llm')).toBeUndefined()
  expect(ctx.get('sessionLog')).toBeUndefined()
})

test('declares four capabilities and only mounts the selected ones', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cubus-local-host-'))
  directories.push(directory)
  await writeFile(join(directory, 'note.txt'), 'hello\n', 'utf8')
  const adapter: LlmAdapter = { provider: 'local-test', model: 'scripted', async *stream() {} }
  const host = createLocalAgentHost({ workspaceDir: directory, adapterFactory: () => adapter })

  expect(host.capabilities?.().map(offering => offering.kind + ':' + offering.provider)).toEqual([
    'llm:local-adapter',
    'session-log:jsonl',
    'fs:local',
    'subprocess:local',
    'sandbox:local-unconfined',
  ])

  const ctx = new Context()
  const fsOfferings = host.capabilities!().filter(offering => offering.kind === 'fs')
  const hostFiber = ctx.plugin({
    name: 'selected-host',
    apply(hostContext: Context) {
      return host.mount(hostContext, { id: 's1', directory, logPath: join(directory, 'session.jsonl') }, fsOfferings)
    },
  })
  await hostFiber

  // 只挂了选中的 fs：llm / session-log / subprocess / sandbox 都不在。
  expect(await ctx.get('fs')!.readText('note.txt')).toBe('hello\n')
  expect(ctx.get('workspaceDir')).toBe(directory)
  expect(ctx.get('llm')).toBeUndefined()
  expect(ctx.get('sessionLog')).toBeUndefined()
  expect(ctx.get('subprocess')).toBeUndefined()
  expect(ctx.get('sandbox')).toBeUndefined()
})

test('mounting everything exposes an explicitly unconfined sandbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cubus-local-host-'))
  directories.push(directory)
  const adapter: LlmAdapter = { provider: 'local-test', model: 'scripted', async *stream() {} }
  const host = createLocalAgentHost({ workspaceDir: directory, adapterFactory: () => adapter })
  const ctx = new Context()
  const fiber = ctx.plugin({
    name: 'all-host',
    apply(hostContext: Context) {
      return host.mount(hostContext, { id: 's1', directory, logPath: join(directory, 'session.jsonl') })
    },
  })
  await fiber

  expect(ctx.sandbox.provider).toBe('local-unconfined')
  expect(ctx.sandbox.features).toEqual(['unconfined'])
  expect(ctx.sandbox.describe()).toContain('no isolation')

  await fiber.dispose()
  expect(ctx.get('sandbox')).toBeUndefined()
})
