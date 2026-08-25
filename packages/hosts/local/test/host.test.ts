import { mkdtemp, rm } from 'node:fs/promises'
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
