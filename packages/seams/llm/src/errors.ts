export type LlmErrorKind =
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'authentication'
  | 'request'
  | 'protocol'

export interface LlmErrorOptions {
  kind: LlmErrorKind
  retryable: boolean
  status?: number
  cause?: unknown
}

/** Provider-neutral failure classification consumed by policies outside the Loop. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly retryable: boolean
  readonly status?: number

  constructor(message: string, options: LlmErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    this.kind = options.kind
    this.retryable = options.retryable
    if (options.status !== undefined) this.status = options.status
  }
}
