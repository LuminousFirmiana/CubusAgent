import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  configPathFrom,
  parseWorkbenchConfig,
  readWorkbenchConfig,
  renderWorkbenchConfigTemplate,
  writeWorkbenchConfig,
} from '../src/config-file.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test('the config path follows --config, then $CUBUS_CONFIG, then XDG, then HOME', () => {
  expect(configPathFrom({ flag: './my.json', env: {} })).toBe(join(process.cwd(), 'my.json'))
  expect(configPathFrom({ env: { [('CUBUS' + '_CONFIG')]: '/tmp/from-env.json', HOME: '/tmp/home' } }))
    .toBe('/tmp/from-env.json')
  expect(configPathFrom({ env: { XDG_CONFIG_HOME: '/tmp/xdg', HOME: '/tmp/home' } }))
    .toBe('/tmp/xdg/cubus/config.json')
  expect(configPathFrom({ env: { HOME: '/tmp/home' } })).toBe('/tmp/home/.cubus/config.json')
})

test('a config file is parsed strictly: unknown keys and wrong types are named', () => {
  expect(parseWorkbenchConfig('{"workspace":"/tmp/repo","approval":"ask","port":4173}', 'c.json'))
    .toEqual({ workspace: '/tmp/repo', approval: 'ask', port: 4173 })

  // 拼错的键必须报错（静默忽略会让用户以为配置生效了）
  // 报错信息里列出全部已知键（含 MCP 那两个），这样拼错时能一眼看出该写什么
  expect(() => parseWorkbenchConfig('{"workspac":"/tmp/repo"}', 'c.json'))
    .toThrow('c.json: unknown key "workspac" (known keys: ')
  expect(() => parseWorkbenchConfig('{"workspac":"/tmp/repo"}', 'c.json'))
    .toThrow('mcpServers, contextWindow, memoryPath)')
  expect(() => parseWorkbenchConfig('{"approval":"always"}', 'c.json'))
    .toThrow('c.json: "approval" must be one of ask, allow, deny')
  expect(() => parseWorkbenchConfig('{"workspace":""}', 'c.json'))
    .toThrow('c.json: "workspace" must be a non-empty string')
  expect(() => parseWorkbenchConfig('{"port":70000}', 'c.json'))
    .toThrow('c.json: "port" must be an integer between 0 and 65535')
  expect(() => parseWorkbenchConfig('{"maxAttempts":0}', 'c.json'))
    .toThrow('c.json: "maxAttempts" must be a positive integer')
  expect(() => parseWorkbenchConfig('[]', 'c.json')).toThrow('c.json: expected a JSON object')
  expect(() => parseWorkbenchConfig('{oops', 'c.json')).toThrow('c.json: not valid JSON')
})

test('reading a missing config is fine, writing one refuses to clobber', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cubus-config-'))
  directories.push(dir)
  const path = join(dir, 'nested', 'config.json')

  expect(await readWorkbenchConfig(path)).toBeUndefined()

  expect(await writeWorkbenchConfig(path, '/tmp/repo', { force: false })).toBe('written')
  const written = await readWorkbenchConfig(path)
  expect(written?.config.workspace).toBe('/tmp/repo')
  expect(written?.config.approval).toBe('ask')
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ approvalTimeoutSeconds: 120, port: 4173 })

  // 第二次不覆盖（用户手改过的配置不能被悄悄重置）
  await writeFile(path, '{"workspace":"/tmp/mine","approval":"deny"}', 'utf8')
  expect(await writeWorkbenchConfig(path, '/tmp/repo', { force: false })).toBe('exists')
  expect((await readWorkbenchConfig(path))?.config.workspace).toBe('/tmp/mine')
  // --force 才覆盖
  expect(await writeWorkbenchConfig(path, '/tmp/repo', { force: true })).toBe('written')
  expect((await readWorkbenchConfig(path))?.config.workspace).toBe('/tmp/repo')
  expect(renderWorkbenchConfigTemplate('/tmp/repo')).toContain('"approval": "ask"')
})

test('mcpServers and contextWindow are accepted; their shape is checked', () => {
  const parsed = parseWorkbenchConfig(JSON.stringify({
    workspace: '/tmp/repo',
    approval: 'ask',
    mcpServers: [{ name: 'demo', command: 'node', args: ['server.mjs'] }],
    contextWindow: 200_000,
  }), 'test.json')
  expect(parsed.mcpServers).toEqual([{ name: 'demo', command: 'node', args: ['server.mjs'] }])
  expect(parsed.contextWindow).toBe(200_000)

  // 只做"是不是数组 / 是不是合理整数"这一层；服务器条目的细节由 @cubus/mcp 严格校验
  expect(() => parseWorkbenchConfig('{"mcpServers":{}}', 'test.json'))
    .toThrow('"mcpServers" must be an array of server objects')
  expect(() => parseWorkbenchConfig('{"contextWindow":10}', 'test.json'))
    .toThrow('"contextWindow" must be an integer of at least 1000 tokens')
  // 缺省时两个键都不出现（默认值在 main 里给）
  const bare = parseWorkbenchConfig('{"workspace":"/tmp/repo","approval":"ask"}', 'test.json')
  expect(bare.mcpServers).toBeUndefined()
  expect(bare.contextWindow).toBeUndefined()
})