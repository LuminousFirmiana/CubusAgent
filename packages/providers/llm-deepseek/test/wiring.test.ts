import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CredentialsError, LocalCredentials } from '@cubus/credentials'
import {
  createDeepSeekAdapterFactory,
  loadDeepSeekEnvFile,
  MODEL_CREDENTIAL_NAME,
  readDeepSeekEnvironment,
} from '../src/wiring.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function envFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cubus-wiring-'))
  directories.push(dir)
  const path = join(dir, '.env')
  await writeFile(path, content, 'utf8')
  return path
}

test('the .env reader takes only the three DeepSeek keys and tolerates a missing file', async () => {
  const path = await envFile([
    '# 注释',
    'DEEPSEEK_API_KEY=sk-from-file',
    'DEEPSEEK_MODEL=deepseek-reasoner',
    'UNRELATED_SECRET=nope',
  ].join('\n'))

  expect(await loadDeepSeekEnvFile(path)).toEqual({
    DEEPSEEK_API_KEY: 'sk-from-file',
    DEEPSEEK_MODEL: 'deepseek-reasoner',
  })
  expect(await loadDeepSeekEnvFile(join(path, '..', 'missing.env'))).toEqual({})
})

test('environment variables win over the file, and neither process.env nor the caller is mutated', async () => {
  const path = await envFile('DEEPSEEK_API_KEY=sk-from-file\nDEEPSEEK_MODEL=from-file\n')
  const environment: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: 'sk-from-env' }

  const settings = await readDeepSeekEnvironment(environment, path)
  expect(settings).toEqual({ DEEPSEEK_API_KEY: 'sk-from-env', DEEPSEEK_MODEL: 'from-file' })
  // 读配置不该改环境（旧实现会往 process.env 里塞值，那会让"配置来源"变得不可追溯）
  expect(environment).toEqual({ DEEPSEEK_API_KEY: 'sk-from-env' })
  expect(process.env['DEEPSEEK_MODEL']).toBeUndefined()
})

test('the adapter factory needs a credential lease and never exposes the key in the adapter', async () => {
  const credentials = new LocalCredentials({ sources: { [MODEL_CREDENTIAL_NAME]: () => undefined } })
  await expect(createDeepSeekAdapterFactory({ credentials, settings: {} }))
    .rejects.toBeInstanceOf(CredentialsError)

  let key: string | undefined = 'sk-secret-value'
  const withKey = new LocalCredentials({ sources: { [MODEL_CREDENTIAL_NAME]: () => key } })
  const factory = await createDeepSeekAdapterFactory({
    credentials: withKey,
    settings: { DEEPSEEK_MODEL: 'deepseek-chat' },
  })
  // 取样后就地抹掉来源：适配器不该再依赖它（key 已进适配器的 ES 私有字段）
  key = undefined

  const adapter = factory()
  expect(adapter.model).toBe('deepseek-chat')
  const serialized = JSON.stringify(adapter)
  expect(serialized).not.toContain('sk-secret-value')
  expect(serialized).not.toContain('apiKey')
})
