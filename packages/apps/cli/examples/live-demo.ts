/**
 * 实时渲染演示：假模型 + 临时 git 仓库，不联网、不花钱、结果确定。
 *
 *   pnpm run demo:live
 *
 * 演示内容与真实运行完全同一条代码路径（runCodingCommand + live renderer +
 * git 变更报告），只是把模型换成脚本化假模型，因此可以反复跑、逐行对照。
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedAdapter } from '@cubus/llm'
import { LocalSubprocess } from '@cubus/tools'
import { renderCodingResult, runCodingCommand } from '../src/coding.ts'

const output = { write: (line: string) => process.stdout.write(line + '\n') }
const idleSignal = new AbortController().signal
const subprocess = new LocalSubprocess()

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function git(cwd: string, command: string): Promise<void> {
  const result = await subprocess.run('git ' + command, { cwd, signal: idleSignal, timeoutMs: 30_000 })
  if (result.exitCode !== 0) throw new Error(command + ' failed: ' + result.stdout + result.stderr)
}

/** 造一个"测试失败"的小仓库：add 被实现成减法。 */
async function createBrokenRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cubus-live-demo-'))
  const repo = join(root, 'repo')
  await mkdir(join(repo, 'src'), { recursive: true })
  await mkdir(join(repo, 'test'), { recursive: true })
  await writeFile(join(repo, 'package.json'), JSON.stringify({
    name: 'demo-repo',
    private: true,
    type: 'module',
    scripts: { test: "node --test 'test/*.test.ts'" },
  }, null, 2) + '\n', 'utf8')
  await writeFile(join(repo, 'src', 'math.ts'), 'export function add(a: number, b: number): number {\n  return a - b\n}\n', 'utf8')
  await writeFile(join(repo, 'test', 'math.test.ts'), [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import { add } from '../src/math.ts'",
    '',
    "test('add returns the sum', () => {",
    '  assert.equal(add(2, 3), 5)',
    '})',
    '',
  ].join('\n'), 'utf8')
  await git(repo, 'init -q -b main')
  await git(repo, 'config user.email demo@example.com')
  await git(repo, 'config user.name Cubus Demo')
  await git(repo, 'config commit.gpgsign false')
  await git(repo, 'config core.hooksPath /dev/null')
  await git(repo, 'add -A')
  await git(repo, "commit -q -m init")
  return repo
}

const workspace = await createBrokenRepo()

output.write('# 实时渲染演示（假模型，确定性；每个 step 之间停顿 250ms 便于观察）')
output.write('# workspace: ' + workspace)
output.write('')

const result = await runCodingCommand({
  workspace,
  task: '仓库里的测试失败了，请修复它。',
  trustWorkspace: true,
  approval: 'allow',
  sessionsDir: join(workspace, '..', 'sessions'),
}, {
  output,
  adapterFactory: () => new ScriptedAdapter([
    { steps: [
      { chunk: { delta: '先看看失败的测试和实现。\n' } },
      { chunk: { toolCalls: [
        { id: 'call-1', name: 'read_file', args: { path: 'src/math.ts' } },
      ] } },
      { hold: pause(250) },
    ] },
    { steps: [
      { chunk: { delta: '问题找到了：add 写成了减法。\n' } },
      { chunk: { toolCalls: [
        { id: 'call-2', name: 'edit_file', args: { path: 'src/math.ts', old_string: 'a - b', new_string: 'a + b' } },
      ] } },
      { hold: pause(250) },
    ] },
    { steps: [
      { chunk: { delta: '跑一遍测试确认。\n' } },
      { chunk: { toolCalls: [
        { id: 'call-3', name: 'bash', args: { command: "node --test 'test/*.test.ts'" } },
      ] } },
      { hold: pause(250) },
    ] },
    { steps: [{ chunk: { delta: '已修复：add 从减法改为加法，测试通过。' } }] },
  ]),
  generateId: () => 'live-demo-session',
})

output.write('')
renderCodingResult(result, output)
output.write('')
output.write('# 屏幕上的每一行都来自会话日志的落盘事件；日志文件可自行对照：')
output.write('#   cat ' + result.logPath)
