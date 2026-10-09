import { expect, test } from 'vitest'
import {
  assertPinnedImage,
  containerName,
  containerRemoveArgs,
  containerRunArgs,
  copyInArgs,
  defaultSandboxSpec,
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

test('commands run through a login shell inside the container workdir', () => {
  expect(execArgs('cubus-x', 'npm test', '/workspace')).toEqual([
    'exec', '-i', '-w', '/workspace', 'cubus-x', 'sh', '-lc', 'npm test',
  ])
  expect(copyInArgs('cubus-x', '/tmp/payload', '/workspace/a.ts')).toEqual([
    'cp', '/tmp/payload', 'cubus-x:/workspace/a.ts',
  ])
})
