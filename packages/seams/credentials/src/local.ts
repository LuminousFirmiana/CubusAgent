import { CredentialsError } from './types.ts'
import type { CredentialLease, CredentialReference, CredentialsProvider } from './types.ts'

export interface LocalCredentialsOptions {
  /**
   * 凭据名 -> 取值函数。来源由 app 决定（环境变量、.env、钥匙串…），
   * seam 只关心"按名字发放"，不关心值从哪来 —— 换成 vault provider 时调用方不改。
   */
  readonly sources: Readonly<Record<string, () => string | undefined>>
}

/**
 * 本地凭据 provider：从 app 提供的取值函数发放租约。
 *
 * 白名单语义：只有列在 sources 里的名字可发放；未列出的名字一律拒绝。
 * 这与子进程环境白名单（@cubus/tools）配对：命令默认拿不到任何凭据，
 * 需要时必须显式经过这里。
 */
export class LocalCredentials implements CredentialsProvider {
  readonly provider = 'local-env'
  readonly names: readonly string[]
  private readonly sources: Readonly<Record<string, () => string | undefined>>

  constructor(options: LocalCredentialsOptions) {
    this.sources = options.sources
    this.names = Object.keys(options.sources).sort()
  }

  async issue(reference: CredentialReference): Promise<CredentialLease> {
    const source = this.sources[reference.name]
    if (source === undefined) {
      throw new CredentialsError(
        'credential not in the local allowlist: ' + reference.name + ' (available: ' + this.names.join(', ') + ')',
      )
    }
    const value = source()
    if (value === undefined || value === '') {
      throw new CredentialsError('credential ' + reference.name + ' is not available from its source')
    }
    return {
      reference,
      reveal: () => value,
      // 本地来源没有可撤销的资源；容器/密钥管理 provider 会在这里回收租约。
      release: async () => undefined,
    }
  }
}
