import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const directories: string[] = []
const packageRoot = join(import.meta.dirname, '..')

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function executeCli(args: readonly string[]): Promise<{ exitCode: number | null, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/main.ts', ...args], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', exitCode => resolve({ exitCode, stdout, stderr }))
  })
}

test('accepts the pnpm separator and prints help with exit code zero', async () => {
  const result = await executeCli(['--', '--help'])

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('pnpm run cubus -- coding')
  expect(result.stderr).toBe('')
})

test('the real process rejects an untrusted workspace without requiring model credentials', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'cubus-cli-e2e-'))
  directories.push(workspace)
  const result = await executeCli([
    '--',
    'coding',
    '--workspace', workspace,
    '--task', 'must not run',
  ])

  expect(result.exitCode).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain('refusing to run tools without --trust-workspace')
  expect(result.stderr).not.toContain('DEEPSEEK_API_KEY')
})
