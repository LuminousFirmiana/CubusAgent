import type { SandboxFeature, SandboxProvider } from '@cubus/sandbox'
import type { DockerSandboxSpec } from './spec.ts'

/** Docker 沙箱的能力描述：这些 features 是**可被拒绝测试验证**的断言。 */
export class DockerSandbox implements SandboxProvider {
  readonly provider = 'docker'
  readonly features: readonly SandboxFeature[] = [
    'fs-isolation',
    'network-deny',
    'resource-limits',
    'pid-isolation',
  ]
  private readonly spec: DockerSandboxSpec

  constructor(spec: DockerSandboxSpec) {
    this.spec = spec
  }

  describe(): string {
    return 'docker ' + this.spec.image +
      ' [network none, user ' + this.spec.user +
      ', mem ' + this.spec.memoryLimit +
      ', cpus ' + this.spec.cpuLimit +
      ', pids ' + String(this.spec.pidsLimit) +
      ', workdir ' + this.spec.workdir + ']'
  }
}
