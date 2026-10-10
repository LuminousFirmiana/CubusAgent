import { expect, test } from 'vitest'
import {
  assertPinnedImage,
  containerName,
  containerRemoveArgs,
  containerRunArgs,
  copyInArgs,
  defaultSandboxSpec,
  killProcessGroupArgs,
  execArgs,
} from '../src/index.ts'

const spec = defaultSandboxSpec({
  sessionId: 'session-abc',
  workspaceDir: '/tmp/host-workspace',
  image: 'node@sha256:' + 'a'.repeat(64),
})

test('the container is created with every boundary explicitly pinned', () => {
  const args = containerRunArgs(spec)

  // 网络：默认全关
  expect(args).toContain('--network')
  expect(args[args.indexOf('--network') + 1]).toBe('none')
  // 权限：非 root、零 capability、不可提权
  expect(args[args.indexOf('--user') + 1]).toBe(spec.user)
  expect(spec.user).not.toBe('0:0')
  expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL')
  expect(args).toContain('no-new-privileges')
  // 资源上限
  expect(args[args.indexOf('--memory') + 1]).toBe('1g')
  expect(args[args.indexOf('--pids-limit') + 1]).toBe('256')
  expect(args[args.indexOf('--cpus') + 1]).toBe('1.5')
  // 只读 rootfs + 小 tmpfs
  expect(args).toContain('--read-only')
  expect(args).toContain('/tmp:rw,nosuid,nodev,size=64m')
  // 只挂工作区，且绝不挂 docker.sock
  expect(args[args.indexOf('-v') + 1]).toBe('/tmp/host-workspace:/workspace:rw')
  expect(args.join(' ')).not.toContain('docker.sock')
  // 镜像以 digest 结尾，容器内可自证是沙箱
  expect(args).toContain(spec.image)
  expect(args).toContain('CUBUS_SANDBOX=docker')
  expect(args).toContain('sleep')
})

test('an image without a digest is rejected instead of silently following a tag', () => {
  expect(() => assertPinnedImage('node:22-slim')).toThrow('must be pinned by digest')
  expect(() => assertPinnedImage('node@sha256:short')).toThrow('must be pinned by digest')
  expect(() => assertPinnedImage('node@sha256:' + 'a'.repeat(64))).not.toThrow()
  expect(() => containerRunArgs({ ...spec, image: 'node:latest' })).toThrow('must be pinned by digest')
})

test('the default image is the pinned official node slim image', () => {
  const defaultSpec = defaultSandboxSpec({ sessionId: 's1', workspaceDir: '/w' })
  expect(defaultSpec.image).toMatch(/^node@sha256:[0-9a-f]{64}$/)
  expect(defaultSpec.workdir).toBe('/workspace')
  expect(() => assertPinnedImage(defaultSpec.image)).not.toThrow()
})

test('container names are derived from the session id and stay shell-safe', () => {
  expect(containerName('abc-123')).toBe('cubus-abc-123')
  expect(containerName('a b/c;rm -rf /')).toBe('cubus-abcrm-rf')
  expect(containerRemoveArgs('cubus-x')).toEqual(['rm', '-f', 'cubus-x'])
})

test('commands run through a login shell inside a recorded process group', () => {
  expect(execArgs('cubus-x', 'npm test', '/workspace', '/tmp/cubus-pgid-1')).toEqual([
    'exec', '-i', '-w', '/workspace', 'cubus-x',
    // -w 是必须的：没有它 setsid 的 fork 会让每条命令的退出码都变成 0
    'setsid', '-w', 'sh', '-c', 'echo $$ > /tmp/cubus-pgid-1; exec sh -lc "$1"',
    'cubus-runner', 'npm test',
  ])
  // 命令原文是**独立 argv**：命令里的引号不会被宿主 shell 改写
  expect(execArgs('cubus-x', 'echo "a b" && rm -rf x', '/workspace', '/tmp/p')).toContain('echo "a b" && rm -rf x')
  expect(copyInArgs('cubus-x', '/tmp/payload', '/workspace/a.ts')).toEqual([
    'cp', '/tmp/payload', 'cubus-x:/workspace/a.ts',
  ])
})

test('process group cleanup uses a negative pid with -- and escalates TERM -> KILL', () => {
  const args = killProcessGroupArgs('cubus-x', '/tmp/cubus-pgid-7')
  expect(args.slice(0, 3)).toEqual(['exec', 'cubus-x', 'sh'])
  const script = args[4] ?? ''
  // 关键：负 PID 必须带 --（否则 dash 把 -$p 当信号选项解析，实测 exit=2 一个都没杀掉）
  expect(script).toContain('kill -s TERM -- -"$p"')
  expect(script).toContain('kill -s KILL -- -"$p"')
  expect(script).toContain('rm -f /tmp/cubus-pgid-7')
  // pid 文件缺失时安静退出（命令可能已经跑完）
  expect(script).toContain('[ -n "$p" ] || exit 0')
})

test('containers start with docker init so cancelled orphans get reaped', () => {
  const args = containerRunArgs(defaultSandboxSpec({ sessionId: 's1', workspaceDir: '/tmp/ws' }))
  // PID 1 是 sleep infinity：没有 --init 时被取消的子进程会变成僵尸直到容器销毁
  expect(args).toContain('--init')
  expect(args[args.indexOf('--init') + 1]).toBe('--network')
})
