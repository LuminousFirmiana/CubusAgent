import type { AgentHost, AgentSessionDescriptor, HostCapabilityOffering } from '@cubus/agent-recipe'
import type { Context } from '@cubus/cordis'
import type { CredentialsProvider } from '@cubus/credentials'
import type { LlmAdapter } from '@cubus/llm'
import { jsonlSessionPlugin } from '@cubus/session-jsonl'
import { LocalSubprocess } from '@cubus/tools'
import { DockerClient } from './client.ts'
import { DockerFs } from './fs.ts'
import { DockerSandbox } from './sandbox.ts'
import { containerName, defaultSandboxSpec } from './spec.ts'
import type { DockerSandboxSpec } from './spec.ts'
import { DockerSubprocess } from './subprocess.ts'

export interface DockerAgentHostOptions {
  /** 每会话一个适配器实例（与本地 Host 同规则）。 */
  adapterFactory: () => LlmAdapter
  /** 宿主工作区路径：bind mount 进容器（只读挂载之外唯一可见的宿主目录）。 */
  workspaceDir: string
  /** 必须 pin digest 的镜像；默认官方 node slim 的 multi-arch digest。 */
  image?: string
  workdir?: string
  user?: string
  memoryLimit?: string
  cpuLimit?: string
  pidsLimit?: number
  credentials?: CredentialsProvider
  /** docker CLI 需要的宿主环境（默认只放行 DOCKER_HOST / DOCKER_CONTEXT）。 */
  dockerEnvAllowlist?: readonly string[]
}

/**
 * 容器化 Host（C4）：把 fs / subprocess / sandbox 三项能力都落到一个会话级容器里。
 *
 * 边界（全部在 containerRunArgs 里钉死）：--network none、非 root、cap-drop ALL、
 * no-new-privileges、只读 rootfs + 小 tmpfs、内存/CPU/PID 上限、只挂工作区、
 * 不挂 docker.sock。容器随会话装配创建、随卸载销毁。
 */
export function createDockerAgentHost(options: DockerAgentHostOptions): AgentHost {
  const subprocess = new LocalSubprocess({
    allowEnv: options.dockerEnvAllowlist ?? ['DOCKER_HOST', 'DOCKER_CONTEXT'],
  })
  const client = new DockerClient(subprocess)
  const credentials = options.credentials
  const workdir = options.workdir ?? '/workspace'

  const specFor = (session: AgentSessionDescriptor): DockerSandboxSpec => defaultSandboxSpec({
    sessionId: session.id,
    workspaceDir: options.workspaceDir,
    workdir,
    ...(options.image === undefined ? {} : { image: options.image }),
    ...(options.user === undefined ? {} : { user: options.user }),
    ...(options.memoryLimit === undefined ? {} : { memoryLimit: options.memoryLimit }),
    ...(options.cpuLimit === undefined ? {} : { cpuLimit: options.cpuLimit }),
    ...(options.pidsLimit === undefined ? {} : { pidsLimit: options.pidsLimit }),
  })

  const offerings: readonly HostCapabilityOffering[] = [
    {
      kind: 'llm',
      provider: 'local-adapter',
      features: ['tool-calling', 'streaming'],
      mount(ctx: Context) {
        ctx.provide('llm', options.adapterFactory())
      },
    },
    {
      kind: 'session-log',
      provider: 'jsonl',
      features: ['live-subscribe'],
      async mount(ctx: Context, session) {
        await ctx.plugin(jsonlSessionPlugin, { path: session.logPath })
      },
    },
    {
      kind: 'sandbox',
      provider: 'docker',
      features: ['fs-isolation', 'network-deny', 'resource-limits', 'pid-isolation'],
      mount(ctx: Context, session) {
        ctx.provide('sandbox', new DockerSandbox(specFor(session)))
      },
    },
    {
      kind: 'fs',
      provider: 'docker',
      features: ['read', 'write'],
      mount(ctx: Context, session) {
        ctx.provide('fs', new DockerFs(client, containerName(session.id), workdir))
        // 容器内看到的工作区就是 workdir（recipe 用它拼 bash cwd 与提示信息）。
        ctx.provide('workspaceDir', workdir)
      },
    },
    {
      kind: 'subprocess',
      provider: 'docker',
      features: ['cancellation', 'process-group-kill'],
      mount(ctx: Context, session) {
        ctx.provide('subprocess', new DockerSubprocess(client, containerName(session.id), workdir))
      },
    },
    ...(credentials === undefined ? [] : [{
      kind: 'credentials' as const,
      provider: credentials.provider,
      features: [...credentials.names],
      mount(ctx: Context) {
        ctx.provide('credentials', credentials)
      },
    }]),
  ]

  return {
    capabilities: () => offerings,
    async mount(ctx: Context, session, selection) {
      // 容器生命周期：先注册清理（同步），再起容器；任何后续失败都会回卷到删容器。
      let container: string | undefined
      ctx.effect(() => () => {
        if (container === undefined) return
        return client.removeContainer(container).then(result => {
          if (result.exitCode !== 0) {
            throw new Error('failed to remove sandbox container ' + container + ': ' + result.stderr.trim())
          }
        })
      })
      container = await client.startContainer(specFor(session))
      for (const offering of selection ?? offerings) {
        await offering.mount(ctx, session)
      }
    },
  }
}
