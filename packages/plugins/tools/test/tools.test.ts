import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { FsError, LocalFs } from '../src/fs.ts'
import type { FsProvider } from '../src/fs.ts'
import { LocalSubprocess } from '../src/subprocess.ts'
import type { SubprocessProvider } from '../src/subprocess.ts'
import { createBashTool, createEditFileTool, createReadFileTool, createWriteFileTool } from '../src/tools.ts'

const activeSignal = new AbortController().signal
const executionContext = { signal: activeSignal }

/** 假 provider：工具测试绝不碰真实磁盘/进程。 */
function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const writes: { path: string; content: string }[] = []
  const provider: FsProvider = {
    async readText(path: string) {
      const content = files.get(path)
      if (content === undefined) throw new FsError(`read failed: ${path}`)
      return content
    },
    async writeText(path: string, content: string) {
      files.set(path, content)
      writes.push({ path, content })
    },
  }
  return { provider, files, writes }
}
function fakeSubprocess() {
  const calls: string[] = []
  const signals: AbortSignal[] = []
  const provider: SubprocessProvider = {
    async run(command: string, options) {
      calls.push(command)
      signals.push(options.signal)
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  return { provider, calls, signals }
}

test('read_file reads through the injected provider and formats the output', async () => {
  const { provider } = fakeFs({ 'src/a.ts': 'const a = 1' })
  const tool = createReadFileTool(provider)

  expect(await tool.execute({ path: 'src/a.ts' }, executionContext)).toBe('# src/a.ts\n\nconst a = 1')
})

test('write_file and edit_file write through the injected provider', async () => {
  const { provider, files, writes } = fakeFs({ 'src/a.ts': 'return a - b' })

  await createWriteFileTool(provider).execute({ path: 'new.txt', content: '你好' }, executionContext)
  expect(files.get('new.txt')).toBe('你好')
  expect(writes).toHaveLength(1)

  const result = await createEditFileTool(provider).execute({
    path: 'src/a.ts',
    old_string: 'a - b',
    new_string: 'a + b',
  }, executionContext)
  expect(result).toContain('edited')
  expect(files.get('src/a.ts')).toBe('return a + b')
})

test('edit_file throws when old_string is missing or ambiguous', async () => {
  const { provider } = fakeFs({ 'a.ts': 'return x + x' })
  const tool = createEditFileTool(provider)

  await expect(tool.execute({ path: 'a.ts', old_string: '没有', new_string: 'x' }, executionContext)).rejects.toThrow('not found')
  await expect(tool.execute({ path: 'a.ts', old_string: 'x', new_string: 'y' }, executionContext)).rejects.toThrow('appears 2 times')
})

test('tools reject non-string arguments', async () => {
  const { provider } = fakeFs()
  const tool = createReadFileTool(provider)
  await expect(tool.execute({ path: 42 }, executionContext)).rejects.toThrow('must be a string')
  await expect(tool.execute({}, executionContext)).rejects.toThrow('missing argument')
})

test('bash formats exit code, stdout, stderr', async () => {
  const { provider, calls, signals } = fakeSubprocess()
  const tool = createBashTool(provider, '/work')

  const result = await tool.execute({ command: 'echo hi' }, executionContext)
  expect(calls).toEqual(['echo hi'])
  expect(signals).toEqual([activeSignal])
  expect(result).toContain('exit code: 0')
})

test('write tools reject an already-cancelled invocation before mutation', async () => {
  const { provider, writes } = fakeFs({ 'a.ts': 'before' })
  const controller = new AbortController()
  controller.abort(new Error('cancel write'))

  await expect(createWriteFileTool(provider).execute(
    { path: 'new.txt', content: 'after' },
    { signal: controller.signal },
  )).rejects.toThrow('cancel write')
  await expect(createEditFileTool(provider).execute(
    { path: 'a.ts', old_string: 'before', new_string: 'after' },
    { signal: controller.signal },
  )).rejects.toThrow('cancel write')
  expect(writes).toEqual([])
})

test('LocalFs rejects path traversal and absolute paths', async () => {
  const fs = new LocalFs('/root')
  await expect(fs.readText('../etc/passwd')).rejects.toThrow(FsError)
  await expect(fs.readText('/etc/passwd')).rejects.toThrow(FsError)
})

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cubus-tools-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

test('LocalFs and LocalSubprocess work against the real filesystem', async () => {
  const fs = new LocalFs(dir)
  await fs.writeText('a.txt', '内容')
  expect(await fs.readText('a.txt')).toBe('内容')

  const subprocess = new LocalSubprocess()
  const result = await subprocess.run('echo hello', { cwd: dir, signal: activeSignal })
  expect(result.stdout.trim()).toBe('hello')
  expect(result.exitCode).toBe(0)
})

test('LocalSubprocess withholds ambient credentials but preserves ordinary environment', async () => {
  const secretName = 'CUBUS_SUBPROCESS_TEST_SECRET'
  const visibleName = 'CUBUS_SUBPROCESS_TEST_VISIBLE'
  const previousSecret = process.env[secretName]
  const previousVisible = process.env[visibleName]
  process.env[secretName] = 'must-not-leak'
  process.env[visibleName] = 'still-visible'

  try {
    const script = `process.stdout.write(JSON.stringify({ secret: process.env.${secretName}, visible: process.env.${visibleName} }))`
    const result = await new LocalSubprocess().run(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      { cwd: dir, signal: activeSignal },
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ visible: 'still-visible' })
  } finally {
    if (previousSecret === undefined) delete process.env[secretName]
    else process.env[secretName] = previousSecret
    if (previousVisible === undefined) delete process.env[visibleName]
    else process.env[visibleName] = previousVisible
  }
})

test.runIf(process.platform !== 'win32')('LocalSubprocess aborts the shell process group', async () => {
  const readyPath = join(dir, 'ready.txt')
  const latePath = join(dir, 'late.txt')
  const grandchildScript = [
    "process.on('SIGTERM', () => {})",
    `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(latePath)}, 'late'), 250)`,
    'setInterval(() => {}, 1000)',
  ].join(';')
  const parentScript = [
    `require('node:fs').writeFileSync(${JSON.stringify(readyPath)}, 'ready')`,
    `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' })`,
    'setInterval(() => {}, 1000)',
  ].join(';')
  const controller = new AbortController()
  const operation = new LocalSubprocess().run(
    `${JSON.stringify(process.execPath)} -e ${JSON.stringify(parentScript)}`,
    { cwd: dir, signal: controller.signal, timeoutMs: 5_000 },
  )

  await vi.waitFor(async () => {
    const ready = await readFile(readyPath, 'utf8').catch(() => undefined)
    expect(ready).toBe('ready')
  })
  controller.abort(new Error('cancel command'))

  await expect(operation).rejects.toThrow('cancel command')
  await new Promise(resolve => setTimeout(resolve, 400))
  await expect(access(latePath)).rejects.toThrow()
})
