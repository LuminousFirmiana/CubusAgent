/**
 * Docker 沙箱的参数构造（C4）：纯函数，先单测再跑真容器。
 *
 * 安全默认值不是"记得加"，而是"构造出来就带着"：
 * 网络关闭、非 root、cap-drop ALL、no-new-privileges、只读 rootfs、
 * 资源上限、不挂 docker.sock（我们根本不加那个 -v）。
 */

/** 默认镜像：官方 node slim，pin 到 multi-arch digest（tag 可变，等于把供应链责任交出去）。 */
export const DEFAULT_DOCKER_IMAGE =
  'node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392'

export interface DockerSandboxSpec {
  /** 会话 id：用于容器名与容器内标记。 */
  readonly sessionId: string
  /** 必须 pin digest 的镜像。 */
  readonly image: string
  /** 宿主工作区路径（bind mount 进容器）。 */
  readonly workspaceDir: string
  /** 容器内工作目录。 */
  readonly workdir: string
  /** 容器内运行用户（默认取宿主 uid:gid，保证 bind mount 可写且非 root）。 */
  readonly user: string
  readonly memoryLimit: string
  readonly cpuLimit: string
  readonly pidsLimit: number
}

export function defaultSandboxSpec(options: {
  sessionId: string
  workspaceDir: string
  image?: string
  workdir?: string
  user?: string
  memoryLimit?: string
  cpuLimit?: string
  pidsLimit?: number
}): DockerSandboxSpec {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  return {
    sessionId: options.sessionId,
    image: options.image ?? DEFAULT_DOCKER_IMAGE,
    workspaceDir: options.workspaceDir,
    workdir: options.workdir ?? '/workspace',
    // 非 root：容器内用宿主 uid 运行，bind mount 因此可写（CI 上是 runner 的 uid）。
    user: options.user ?? (uid === undefined ? '1000:1000' : uid + ':' + (gid ?? uid)),
    memoryLimit: options.memoryLimit ?? '1g',
    cpuLimit: options.cpuLimit ?? '1.5',
    pidsLimit: options.pidsLimit ?? 256,
  }
}

/** 镜像必须 pin 到 digest；不 pin 就没有可追溯的供应链边界。 */
export function assertPinnedImage(image: string): void {
  if (!/^[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/.test(image)) {
    throw new Error('docker image must be pinned by digest (name@sha256:<64 hex>): ' + image)
  }
}

export function containerName(sessionId: string): string {
  return 'cubus-' + sessionId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40)
}

/** `docker run -d ...`：容器的全部边界都在这里被钉死。 */
export function containerRunArgs(spec: DockerSandboxSpec): string[] {
  assertPinnedImage(spec.image)
  return [
    'run', '-d',
    '--name', containerName(spec.sessionId),
    // 网络：v1 只有 none（设计文档 §12 决定 2）
    '--network', 'none',
    // 权限：非 root、零 capability、不可提权
    '--user', spec.user,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    // 资源上限
    '--pids-limit', String(spec.pidsLimit),
    '--memory', spec.memoryLimit,
    '--memory-swap', spec.memoryLimit,
    '--cpus', spec.cpuLimit,
    // 只读 rootfs；/tmp 给一块小的可写 tmpfs（HOME 也指到那里）
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
    '-e', 'HOME=/tmp',
    // 就地标记：容器内能看出自己是沙箱（拒绝测试与排查都用它）
    '-e', 'CUBUS_SANDBOX=docker',
    '-e', 'CUBUS_SESSION=' + spec.sessionId,
    // 只挂工作区；绝不挂 docker.sock 或宿主其它路径
    '-v', spec.workspaceDir + ':' + spec.workdir + ':rw',
    '-w', spec.workdir,
    spec.image,
    'sleep', 'infinity',
  ]
}

export function containerRemoveArgs(container: string): string[] {
  return ['rm', '-f', container]
}

/** `docker exec`：容器内环境来自容器本身，宿主环境不会随之进入。 */
export function execArgs(container: string, command: string, workdir: string): string[] {
  return ['exec', '-i', '-w', workdir, container, 'sh', '-lc', command]
}

/** `docker cp`：宿主临时文件 -> 容器内路径（写文件用，避免把内容放进命令行）。 */
export function copyInArgs(container: string, hostPath: string, containerPath: string): string[] {
  return ['cp', hostPath, container + ':' + containerPath]
}
