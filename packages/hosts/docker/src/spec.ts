/**
 * Docker 沙箱的参数构造（C4）：纯函数，先单测再跑真容器。
 *
 * 安全默认值不是"记得加"，而是"构造出来就带着"：
 * 网络关闭、非 root、cap-drop ALL、no-new-privileges、只读 rootfs、
 * 资源上限、不挂 docker.sock（我们根本不加那个 -v）。
 */

/**
 * 默认镜像：官方 node slim，pin 到 multi-arch digest（tag 可变，等于把供应链责任交出去）。
 *
 * **升级流程**（改这个常量之前照做；集成测试会在镜像换代后第一时间报错）：
 * 1. `docker pull node:<tag>`，再 `docker inspect --format '{{index .RepoDigests 0}}' node:<tag>` 拿新 digest；
 * 2. 替换下面的常量（必须是 name@sha256:<64 hex>，assertPinnedImage 会拒绝 tag）；
 * 3. 跑 `pnpm --filter @cubus/host-docker run test`：真容器契约测试会核对
 *    边界（无网络、非 root、只读根、只有工作区可见）与**取消机制依赖的工具**（sh/setsid/cat/rm/sleep）；
 * 4. 若 `setsid` 或 shell 行为变了，更新 docs/design/sandbox-seam.md 与 handover。
 */
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
    // PID 1 用 docker 自带的 init（tini）：容器里 PID 1 是 sleep infinity，不会 reap 孤儿，
    // 被取消的命令会留下僵尸直到容器销毁（实测：没有 --init 时 "sleep 300 & wait" 被杀后留下 Z 进程）
    '--init',
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

/**
 * `docker exec`：容器内环境来自容器本身，宿主环境不会随之进入。
 *
 * 命令被 **setsid** 包一层，成为独立会话/进程组的首进程，并把它的 PID 写进 pidFile：
 * setsid 之后 PGID == PID，所以这个值就是可被"组杀"的进程组号（见 killProcessGroupArgs）。
 * 不这么做，取消只能杀掉宿主侧的 docker exec，容器内的子进程会活到容器销毁。
 *
 * 参数不经宿主 shell：`docker exec ... setsid sh -c '<recorder>' cubus-runner <command>`，
 * recorder 里的 $1 就是命令原文（命令里的引号原样保留）。
 */
export function execArgs(container: string, command: string, workdir: string, pidFile: string): string[] {
  return [
    'exec', '-i', '-w', workdir, container,
    // -w（--wait）不能少：setsid 会 fork，父进程立刻以 0 退出，docker exec 就会把
    // 每条命令都看成成功（实测 `exit 7` 不带 -w 得 0、带 -w 得 7）
    'setsid', '-w', 'sh', '-c',
    'echo $$ > ' + pidFile + '; exec sh -lc "$1"',
    'cubus-runner',
    command,
  ]
}

/**
 * 取消/超时后的**容器内进程组清理**：先 TERM，最多等 1.5 秒，再 KILL。
 *
 * 必须写 `kill -s TERM -- -"$p"`：少了 `--` 时 dash 会把负 PID 当信号选项解析
 * （实测 exit=2 且一个进程都没杀掉）；这些镜像里也没有 /bin/kill，只能用 shell 内建。
 * pidFile 不存在时安静退出（命令可能已经自己跑完了）。
 */
export function killProcessGroupArgs(container: string, pidFile: string): string[] {
  const script = [
    'p=$(cat ' + pidFile + ' 2>/dev/null)',
    '[ -n "$p" ] || exit 0',
    'kill -s TERM -- -"$p" 2>/dev/null',
    'i=0',
    'while [ $i -lt 15 ] && kill -0 -"$p" 2>/dev/null; do sleep 0.1; i=$((i+1)); done',
    'kill -s KILL -- -"$p" 2>/dev/null',
    'rm -f ' + pidFile,
    'exit 0',
  ].join('; ')
  return ['exec', container, 'sh', '-c', script]
}

/** `docker cp`：宿主临时文件 -> 容器内路径（写文件用，避免把内容放进命令行）。 */
export function copyInArgs(container: string, hostPath: string, containerPath: string): string[] {
  return ['cp', hostPath, container + ':' + containerPath]
}
