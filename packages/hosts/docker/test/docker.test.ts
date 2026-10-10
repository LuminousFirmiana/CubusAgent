import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { Context } from '@cubus/cordis'
import { DockerClient } from '../src/client.ts'
import { DockerFs } from '../src/fs.ts'
import { DockerSubprocess } from '../src/subprocess.ts'
import { containerName, defaultSandboxSpec } from '../src/spec.ts'
import { LocalSubprocess } from '@cubus/tools'

const idleSignal = new AbortController().signal
const prober = new LocalSubprocess()

/**
 * Docker 不可用（或镜像拿不到）时不假装通过：显式跳过并打印原因。
 * 契约测试（spec.test.ts）在任何环境下都必跑，集成测试才受此影响。
 */
async function dockerSkipReason(): Promise<string | undefined> {
  const info = await prober.run('docker info --format "{{.ServerVersion}}"', {
    cwd: tmpdir(),
    signal: idleSignal,
    timeoutMs: 20_000,
  })
  if (info.exitCode !== 0) return 'docker info failed: ' + info.stderr.trim()

  const image = (await import('../src/spec.ts')).DEFAULT_DOCKER_IMAGE
  const inspect = await prober.run('docker image inspect ' + image + ' > /dev/null 2>&1 || docker pull ' + image, {
    cwd: tmpdir(),
    signal: idleSignal,
    timeoutMs: 300_000,
  })
  if (inspect.exitCode !== 0) return 'cannot obtain pinned image: ' + inspect.stderr.trim()
  return undefined
}

const skipReason = await dockerSkipReason()
const integration = skipReason === undefined ? test : test.skip
if (skipReason !== undefined) {
  console.warn('[C4] skipping real Docker tests: ' + skipReason)
}

const cleanups: (() => Promise<void>)[] = []
const createdContainers: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  // 兜底：清掉本次测试留下的容器（名字前缀 cubus-test-）
  await prober.run('docker ps -aq --filter name=cubus-test- | xargs -r docker rm -f', {
    cwd: tmpdir(),
    signal: idleSignal,
    timeoutMs: 60_000,
  })
})

/** 起一个真实沙箱容器 + 一个宿主工作区。 */
async function startSandbox(): Promise<{
  container: string
  workspace: string
  outside: string
  client: DockerClient
}> {
  const workspace = await mkdtemp(join(tmpdir(), 'cubus-docker-ws-'))
  const outside = await mkdtemp(join(tmpdir(), 'cubus-docker-outside-'))
  cleanups.push(async () => {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  const client = new DockerClient(new LocalSubprocess({ allowEnv: ['DOCKER_HOST', 'DOCKER_CONTEXT'] }))
  const spec = defaultSandboxSpec({
    sessionId: 'test-' + Math.random().toString(36).slice(2, 10),
    workspaceDir: workspace,
  })
  const container = await client.startContainer(spec)
  createdContainers.push(container)
  cleanups.push(async () => {
    await client.removeContainer(container)
  })
  return { container, workspace, outside, client }
}

integration('the workspace is shared with the container, the rest of the host is not', async () => {
  const { container, workspace, outside, client } = await startSandbox()
  await writeFile(join(workspace, 'visible.txt'), 'from the host\n', 'utf8')
  await writeFile(join(outside, 'secret.txt'), 'host-only\n', 'utf8')

  const fromContainer = await client.exec(container, 'cat /workspace/visible.txt', {
    workdir: '/workspace',
    signal: idleSignal,
  })
  expect(fromContainer.exitCode).toBe(0)
  expect(fromContainer.stdout).toBe('from the host\n')

  // 工作区之外：容器里根本不存在那个路径
  const outsideRead = await client.exec(container, 'cat ' + outside + '/secret.txt', {
    workdir: '/workspace',
    signal: idleSignal,
  })
  expect(outsideRead.exitCode).not.toBe(0)
  expect(outsideRead.stdout).not.toContain('host-only')

  // 反向：容器里写的文件出现在宿主工作区（bind mount 生效）
  const wrote = await client.exec(container, 'echo from-container > /workspace/written.txt', {
    workdir: '/workspace',
    signal: idleSignal,
  })
  expect(wrote.exitCode).toBe(0)
  expect(await readFile(join(workspace, 'written.txt'), 'utf8')).toBe('from-container\n')
})

integration('the container has no network and cannot see the docker socket', async () => {
  const { container, client } = await startSandbox()

  const network = await client.exec(
    container,
    'node -e "require(\'net\').connect(80, \'1.1.1.1\').on(\'error\', e => { console.log(\'refused:\' + e.code); process.exit(3) }).on(\'connect\', () => { console.log(\'connected\'); process.exit(0) })"',
    { workdir: '/workspace', signal: idleSignal, timeoutMs: 20_000 },
  )
  expect(network.exitCode).not.toBe(0)
  expect(network.stdout).not.toContain('connected')

  const socket = await client.exec(container, 'ls -l /var/run/docker.sock', {
    workdir: '/workspace',
    signal: idleSignal,
  })
  expect(socket.exitCode).not.toBe(0)
})

integration('host environment variables never enter the container', async () => {
  const { container, client } = await startSandbox()
  process.env['HARMLESS_CREDENTIAL'] = 'must-not-enter-container'
  process.env['DEEPSEEK_API_KEY'] = 'sk-must-not-enter-container'
  try {
    const result = await client.exec(
      container,
      'printenv HARMLESS_CREDENTIAL; printenv DEEPSEEK_API_KEY; echo sandbox=$CUBUS_SANDBOX',
      { workdir: '/workspace', signal: idleSignal },
    )
    expect(result.stdout).not.toContain('must-not-enter-container')
    expect(result.stdout).toContain('sandbox=docker')
  } finally {
    delete process.env['HARMLESS_CREDENTIAL']
    delete process.env['DEEPSEEK_API_KEY']
  }
})

integration('DockerFs reads and writes through the container boundary', async () => {
  const { container, workspace, client } = await startSandbox()
  const fs = new DockerFs(client, container, '/workspace')

  await fs.writeText('src/app.ts', 'export const value = 1\n')
  expect(await readFile(join(workspace, 'src', 'app.ts'), 'utf8')).toBe('export const value = 1\n')
  expect(await fs.readText('src/app.ts')).toBe('export const value = 1\n')

  await expect(fs.readText('../outside.txt')).rejects.toThrow('path escapes workspace')
  await expect(fs.writeText('/etc/passwd', 'nope')).rejects.toThrow('path escapes workspace')
})

integration('containerized commands run in the container and honour cancellation', async () => {
  const { container } = await startSandbox()
  const subprocess = new DockerSubprocess(new DockerClient(new LocalSubprocess()), container, '/workspace')

  const inside = await subprocess.run('node -p "process.env.CUBUS_SANDBOX + \'@\' + process.cwd()"', {
    cwd: '/nonexistent-host-path',
    signal: idleSignal,
  })
  expect(inside.exitCode).toBe(0)
  expect(inside.stdout.trim()).toBe('docker@/workspace')

  // 取消：容器内的长命令被中断，run 在数秒内返回
  const controller = new AbortController()
  const started = Date.now()
  const running = subprocess.run('sleep 30', { cwd: '/workspace', signal: controller.signal })
  setTimeout(() => controller.abort(new Error('cancelled by test')), 300)
  // 取消语义与本地 provider 一致：run 以 abort 原因 reject，且在数秒内返回
  await expect(running).rejects.toThrow('cancelled by test')
  expect(Date.now() - started).toBeLessThan(15_000)
})

integration('a declarative recipe assembles on docker and runs its tools inside the container', async () => {
  const { createDockerAgentHost } = await import('../src/host.ts')
  const { SessionRuntime } = await import('@cubus/sdk')
  const { ScriptedAdapter } = await import('@cubus/llm')
  const { systemPromptContribution } = await import('@cubus/system-prompt')
  const { toolContribution } = await import('@cubus/tool-registry')
  const { createTools } = await import('@cubus/tools')

  const workspace = await mkdtemp(join(tmpdir(), 'cubus-docker-ws-'))
  const sessions = await mkdtemp(join(tmpdir(), 'cubus-docker-sessions-'))
  cleanups.push(async () => {
    await rm(workspace, { recursive: true, force: true })
    await rm(sessions, { recursive: true, force: true })
  })

  // 需要"真隔离"的产品：本地 Host 会因为缺 fs-isolation 而装配期失败。
  const recipe = {
    manifest: {
      contractVersion: 1,
      id: 'docker-eval',
      version: '1.0.0',
      displayName: 'Docker Eval Agent',
      requires: [
        { kind: 'llm', features: ['tool-calling'] },
        { kind: 'session-log' },
        { kind: 'fs', features: ['read', 'write'] },
        { kind: 'subprocess' },
        { kind: 'sandbox', features: ['fs-isolation', 'network-deny'] },
      ],
      prompt: { fragmentId: 'docker-eval/role' },
      tools: ['read_file', 'edit_file', 'write_file', 'bash'],
      permission: { profile: 'allow' },
    },
    async mount(ctx: Context) {
      await ctx.plugin(systemPromptContribution({ id: 'docker-eval/role', text: 'Sandboxed eval agent.' }))
      const fs = ctx.get('fs')
      const subprocess = ctx.get('subprocess')
      const workspaceDir = ctx.get('workspaceDir')
      if (!fs || !subprocess || !workspaceDir) throw new Error('missing host capabilities')
      for (const tool of createTools(fs, subprocess, workspaceDir)) {
        await ctx.plugin(toolContribution(tool))
      }
    },
  }

  const runtime = new SessionRuntime({
    rootDir: sessions,
    host: createDockerAgentHost({
      workspaceDir: workspace,
      adapterFactory: () => new ScriptedAdapter([
        { steps: [{ chunk: { toolCalls: [{
          id: 'bash-1',
          name: 'bash',
          args: { command: 'node -p "process.env.CUBUS_SANDBOX + \'@\' + process.cwd()"' },
        }] } }] },
        { steps: [{ chunk: { delta: 'ran inside the sandbox' } }] },
      ]),
    }),
    recipe: recipe as never,
    recipeOptions: undefined,
    generateId: () => 'docker-session-' + Math.random().toString(36).slice(2, 8),
  })

  const session = await runtime.create()
  createdContainers.push(containerName(session.id))
  const mount = await runtime.mountSnapshot(session.id)
  const run = await runtime.run(session.id, 'Where are you running?')

  // 快照如实记录：这次是真的 Docker 隔离
  // 快照里的 features 是排序过的（确定性）
  expect(mount?.capabilities).toContainEqual({
    kind: 'sandbox',
    provider: 'docker',
    features: ['fs-isolation', 'network-deny', 'pid-isolation', 'resource-limits'],
  })
  // 工具确实跑在容器里（宿主上不可能有这个输出）
  const toolResult = run.turnEvents.find(event => event.type === 'tool/result')
  expect(toolResult?.type === 'tool/result' ? toolResult.output.text : '').toContain('docker@/workspace')
  expect(run.assistantText).toBe('ran inside the sandbox')
})

integration('the container is removed when the session context is disposed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'cubus-docker-ws-'))
  cleanups.push(async () => rm(workspace, { recursive: true, force: true }))
  const { createDockerAgentHost } = await import('../src/host.ts')
  const host = createDockerAgentHost({
    adapterFactory: () => ({ provider: 'test', model: 'none', async *stream() {} }),
    workspaceDir: workspace,
  })
  const sessionId = 'test-dispose-' + Math.random().toString(36).slice(2, 10)
  const container = containerName(sessionId)
  createdContainers.push(container)

  const ctx = new Context()
  const fiber = ctx.plugin({
    name: 'docker-host-test',
    apply(hostContext: Context) {
      const offerings = host.capabilities!()
      const wanted = offerings.filter(offering =>
        offering.kind === 'sandbox' || offering.kind === 'fs' || offering.kind === 'subprocess')
      return host.mount(hostContext, {
        id: sessionId,
        directory: workspace,
        logPath: join(workspace, 'session.jsonl'),
      }, wanted)
    },
  })
  await fiber

  const live = await new LocalSubprocess().run('docker ps -q --filter name=' + container, {
    cwd: tmpdir(),
    signal: idleSignal,
  })
  expect(live.stdout.trim()).not.toBe('')

  await fiber.dispose()

  const gone = await new LocalSubprocess().run('docker ps -aq --filter name=' + container, {
    cwd: tmpdir(),
    signal: idleSignal,
  })
  expect(gone.stdout.trim()).toBe('')
})

/** 列出容器里"活着的" sleep 进程（跳过 PID 1 的 sleep infinity 与僵尸）：失败时能直接看出残留的是谁。 */
async function liveSleeps(client: DockerClient, container: string): Promise<string[]> {
  const script = [
    'n=0',
    'for d in /proc/[0-9]*; do',
    '  pid=' + '${d#/proc/}',
    '  cmd=$(tr "\\000" " " < $d/cmdline 2>/dev/null)',
    // 容器主进程（sleep infinity）要跳过：加了 --init 之后它是普通子进程，不再是 PID 1
    '  [ "$cmd" = "sleep infinity " ] && continue',
    '  set -- $(cat $d/stat 2>/dev/null)',
    '  [ "$2" = "(sleep)" ] || continue',
    '  [ "$3" = "Z" ] && continue',
    '  echo "$pid comm=$2 state=$3 ppid=$4 pgid=$5"',
    'done',
  ].join('\n')
  const result = await client.exec(container, script, { workdir: '/workspace', signal: idleSignal })
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n')
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('condition never became true')
}

integration('cancelling a command kills the in-container process group, not just the docker exec client', async () => {
  const { container, client } = await startSandbox()
  const controller = new AbortController()

  // 典型的孤儿制造机：后台子进程 + 一直等
  const running = client.exec(container, 'sleep 300 & wait', { workdir: '/workspace', signal: controller.signal })
  running.catch(() => undefined)

  // 等容器内记下进程组号：说明命令真的起来了
  await waitFor(async () => {
    const probed = await client.exec(container, 'cat /tmp/cubus-pgid-* 2>/dev/null', {
      workdir: '/workspace',
      signal: idleSignal,
    })
    return probed.stdout.trim().length > 0
  })
  expect(await liveSleeps(client, container)).not.toEqual([])

  controller.abort()
  await expect(running).rejects.toBeDefined()
  expect(await liveSleeps(client, container)).toEqual([])

  // 是"杀进程组"而不是"杀容器"：容器本身照常可用
  const alive = await client.exec(container, 'echo still-alive', { workdir: '/workspace', signal: idleSignal })
  expect(alive.stdout).toContain('still-alive')
})
integration('a host refuses to start more containers than maxContainers, and frees the slot on dispose', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'cubus-docker-cap-'))
  cleanups.push(async () => {
    await rm(workspace, { recursive: true, force: true })
  })
  const { createDockerAgentHost } = await import('../src/host.ts')
  const { ScriptedAdapter } = await import('@cubus/llm')
  const host = createDockerAgentHost({
    adapterFactory: () => new ScriptedAdapter([]),
    workspaceDir: workspace,
    maxContainers: 1,
  })

  const mountSession = (sessionId: string) => {
    createdContainers.push(containerName(sessionId))
    const ctx = new Context()
    return ctx.plugin({
      name: 'docker-host-cap-test',
      apply(hostContext: Context) {
        const wanted = host.capabilities!().filter(offering =>
          offering.kind === 'sandbox' || offering.kind === 'fs' || offering.kind === 'subprocess')
        return host.mount(hostContext, {
          id: sessionId,
          directory: workspace,
          logPath: join(workspace, 'session.jsonl'),
        }, wanted)
      },
    })
  }

  const first = mountSession('test-cap-a-' + Math.random().toString(36).slice(2, 8))
  await first

  // 第二个会话超限：快速失败，错误说清楚是上限问题（而不是 docker 的模糊报错）
  const second = mountSession('test-cap-b-' + Math.random().toString(36).slice(2, 8))
  await expect(second).rejects.toThrow(/refusing to start another sandbox container: 1 of 1/)

  // 释放第一个：名额回来（账本会减，不是只增不减）
  await first.dispose()
  const third = mountSession('test-cap-c-' + Math.random().toString(36).slice(2, 8))
  await third
  await third.dispose()
})
integration('the pinned image still provides the tools the sandbox relies on', async () => {
  const { container, client } = await startSandbox()
  // 取消机制依赖 setsid / sh；命令包装依赖 cat / rm / sleep（见 spec.ts 的 argv 构造）
  const probe = await client.exec(
    container,
    'for tool in sh setsid cat rm sleep; do command -v $tool > /dev/null || echo "missing: $tool"; done; echo checked',
    { workdir: '/workspace', signal: idleSignal },
  )
  expect(probe.stdout).toContain('checked')
  expect(probe.stdout).not.toContain('missing:')
})
