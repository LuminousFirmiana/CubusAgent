import { expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { SANDBOX_EXEC_PATH, SeatbeltSandbox, seatbeltProfile, SandboxUnavailableError } from '../src/index.ts'

const run = promisify(execFile)
const isMac = process.platform === 'darwin'

test('the profile denies by default: writes only inside the workspace, no network', () => {
  const profile = seatbeltProfile({ workspaceDir: '/work/repo' })
  expect(profile).toContain('(deny default)')
  expect(profile).toContain('(allow file-write* (subpath "/work/repo"))')
  // 默认**不**给临时目录：多一个可写路径就是多一个逃逸面
  expect(profile).not.toContain('/tmp')
  expect(profile).toContain('(deny network*)')
  // 读是全开的（我们不承诺读隔离，就不能假装有）
  expect(profile).toContain('(allow file-read*)')
  // 只有显式列出才可写：工作区之外没有 blanket 写权限
  expect(profile).not.toContain('(allow file-write*)')
})

test('opting into the network is explicit', () => {
  const profile = seatbeltProfile({ workspaceDir: '/w', allowNetwork: true, writablePaths: [] })
  expect(profile).toContain('(allow network*)')
  expect(profile).not.toContain('(deny network*)')
})

test('features are honest: write isolation and network deny, but no full fs isolation', () => {
  const sandbox = new SeatbeltSandbox({ workspaceDir: '/w' })
  expect(sandbox.provider).toBe('seatbelt')
  expect([...sandbox.features].sort()).toEqual(['fs-write-isolation', 'network-deny'])
  // 不夸大：没有 fs-isolation / resource-limits / pid-isolation
  expect(sandbox.features).not.toContain('fs-isolation')
  expect(sandbox.describe()).toContain('reads are still open')
  // describe 必须如实列出可写路径（不许含糊成"工作区"）
  expect(sandbox.describe()).toContain('/w')
  expect(sandbox.writablePaths()).toEqual(['/w'])
})

test('unavailable sandbox fails closed instead of silently running unconfined', () => {
  const sandbox = new SeatbeltSandbox({ workspaceDir: '/w', executable: '/nonexistent/sandbox-exec' })
  expect(() => sandbox.assertAvailable()).toThrow(SandboxUnavailableError)
  expect(() => sandbox.assertAvailable()).toThrow('refusing to run commands without isolation')
  // 可用路径不抛（macOS 上 /usr/bin/sandbox-exec 一定在）
  if (isMac) expect(() => new SeatbeltSandbox({ workspaceDir: '/w' }).assertAvailable()).not.toThrow()
})

test('wrap() quotes the profile and the command so neither can escape the shell', () => {
  const sandbox = new SeatbeltSandbox({ workspaceDir: "/w/it's", executable: '/usr/bin/sandbox-exec' })
  const wrapped = sandbox.wrap('echo "hi" && rm -rf /tmp/x')
  expect(wrapped.startsWith("'/usr/bin/sandbox-exec' -p '")).toBe(true)
  expect(wrapped).toContain('/bin/sh -c')
  // 单引号被转义，不能提前闭合
  expect(wrapped).toContain("'\\''")
})

/** 真跑（仅 macOS）：越界写必须被内核拒绝，工作区内写必须成功。 */
test.skipIf(!isMac)('seatbelt really blocks writes outside the workspace', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'cubus-sbx-ws-'))
  const sandbox = new SeatbeltSandbox({ workspaceDir: workspace })

  // 工作区内写：成功
  await run('/bin/sh', ['-c', sandbox.wrap('echo inside > ' + join(workspace, 'ok.txt'))])
  expect(readFileSync(join(workspace, 'ok.txt'), 'utf8').trim()).toBe('inside')

  // 工作区外写：被拒（seatbelt 让命令以非 0 退出）
  // 连 /tmp 都不可写（它不在可写清单里）—— 逃逸面越小越好
  const blocked = join(tmpdir(), 'cubus-sbx-escape-' + String(Date.now()) + '.txt')
  await expect(run('/bin/sh', ['-c', sandbox.wrap('echo nope > ' + blocked)])).rejects.toThrow()
  expect(() => readFileSync(blocked, 'utf8')).toThrow()

  // 断网：连一个必然失败的地址，报错信息里应体现被沙箱挡下
  await expect(run('/bin/sh', ['-c', sandbox.wrap('curl -s -m 3 http://example.com')])).rejects.toThrow()

  writeFileSync(join(workspace, 'done.txt'), 'ok')
  expect(process.env['CUBUS_SKIP_REFERENCE'] ?? SANDBOX_EXEC_PATH).toBeTruthy()
}, 30_000)