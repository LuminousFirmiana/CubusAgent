import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { loadDeepSeekEnvironment } from '../src/index.ts'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('loads only DeepSeek settings and lets process environment override the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cubus-cli-env-'))
  directories.push(directory)
  const envFile = join(directory, '.env')
  await writeFile(envFile, [
    'DEEPSEEK_API_KEY=file-key',
    'DEEPSEEK_MODEL=file-model',
    'UNRELATED_SECRET=must-not-load',
  ].join('\n'))

  expect(await loadDeepSeekEnvironment({ DEEPSEEK_API_KEY: 'process-key' }, envFile)).toEqual({
    DEEPSEEK_API_KEY: 'process-key',
    DEEPSEEK_MODEL: 'file-model',
  })
})
