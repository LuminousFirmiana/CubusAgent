import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { FsError, LocalFs } from '../src/fs.ts'
import type { FsProvider } from '../src/fs.ts'
import { LocalSubprocess } from '../src/subprocess.ts'
import type { SubprocessProvider } from '../src/subprocess.ts'
import { createBashTool, createEditFileTool, createReadFileTool, createWriteFileTool } from '../src/tools.ts'

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
  const provider: SubprocessProvider = {
    async run(command: string) {
      calls.push(command)
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  return { provider, calls }
}

test('read_file reads through the injected provider and formats the output', async () => {
  const { provider } = fakeFs({ 'src/a.ts': 'const a = 1' })
  const tool = createReadFileTool(provider)

  expect(await tool.execute({ path: 'src/a.ts' })).toBe('# src/a.ts\n\nconst a = 1')
})

test('write_file and edit_file write through the injected provider', async () => {
  const { provider, files, writes } = fakeFs({ 'src/a.ts': 'return a - b' })

  await createWriteFileTool(provider).execute({ path: 'new.txt', content: '你好' })
  expect(files.get('new.txt')).toBe('你好')
  expect(writes).toHaveLength(1)

  const result = await createEditFileTool(provider).execute({
    path: 'src/a.ts',
    old_string: 'a - b',
    new_string: 'a + b',
  })
  expect(result).toContain('edited')
  expect(files.get('src/a.ts')).toBe('return a + b')
})

test('edit_file throws when old_string is missing or ambiguous', async () => {
  const { provider } = fakeFs({ 'a.ts': 'return x + x' })
  const tool = createEditFileTool(provider)

  await expect(tool.execute({ path: 'a.ts', old_string: '没有', new_string: 'x' })).rejects.toThrow('not found')
  await expect(tool.execute({ path: 'a.ts', old_string: 'x', new_string: 'y' })).rejects.toThrow('appears 2 times')
})

test('tools reject non-string arguments', async () => {
  const { provider } = fakeFs()
  const tool = createReadFileTool(provider)
  await expect(tool.execute({ path: 42 })).rejects.toThrow('must be a string')
  await expect(tool.execute({})).rejects.toThrow('missing argument')
})

test('bash formats exit code, stdout, stderr', async () => {
  const { provider, calls } = fakeSubprocess()
  const tool = createBashTool(provider, '/work')

  const result = await tool.execute({ command: 'echo hi' })
  expect(calls).toEqual(['echo hi'])
  expect(result).toContain('exit code: 0')
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
  const result = await subprocess.run('echo hello', { cwd: dir })
  expect(result.stdout.trim()).toBe('hello')
  expect(result.exitCode).toBe(0)
})

