/**
 * 凭据 seam 的 Service Definition（C3；设计见 docs/design/sandbox-seam.md §6）。
 *
 * 铁律：
 * 1. 明文永不进会话日志、永不进装配快照、永不进工具结果；
 * 2. 调用方拿到的先是**引用**（名字 + 形态，可安全记录），要用值时才取租约；
 * 3. 租约只在使用边界内有效，用完 release。
 */
export interface CredentialReference {
  /** 凭据名（进快照的 features 只有名字，没有值）。 */
  readonly name: string
  readonly kind: 'env' | 'file'
}

/** 凭据租约：reveal() 是唯一取出明文的入口。 */
export interface CredentialLease {
  readonly reference: CredentialReference
  reveal(): string
  release(): Promise<void>
}

export interface CredentialsProvider {
  /** provider 名，进装配快照：'local-env' | 'docker-secrets' | ... */
  readonly provider: string
  /** 可发放的凭据名（白名单语义：不在名单里的名字一律拒绝）。 */
  readonly names: readonly string[]
  issue(reference: CredentialReference): Promise<CredentialLease>
}

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CredentialsError'
  }
}
