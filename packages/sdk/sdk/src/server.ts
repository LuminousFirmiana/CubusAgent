import type { JsonRpcRequest } from './protocol.ts'
import { RPC_ERROR } from './protocol.ts'
import { parseRequestLine } from './transport.ts'
import type { RpcTransport } from './transport.ts'

/** 一个可调用的 RPC 方法。 */
export type RpcMethod = (params: Record<string, unknown>) => Promise<unknown> | unknown

/**
 * 方法抛出的"参数错误"：映射为 -32602 invalid params。
 * wire 边界上的输入校验失败用它（区别于内部错误 -32603）。
 */
export class RpcInvalidParamsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RpcInvalidParamsError'
  }
}

/**
 * JSON-RPC 服务端：把方法表接到传输上。
 * 职责：解析行 -> 查方法 -> 调用 -> 写响应（含错误映射）。
 */
export class RpcServer {
  private readonly transport: RpcTransport
  private readonly methods: ReadonlyMap<string, RpcMethod>
  private readonly dispose: () => void

  constructor(transport: RpcTransport, methods: Record<string, RpcMethod>) {
    this.transport = transport
    this.methods = new Map(Object.entries(methods))
    this.dispose = transport.onRequest(line => {
      void this.handleLine(line)
    })
  }

  /** 停止监听（关闭通道）。 */
  close(): void {
    this.dispose()
  }

  private write(message: unknown): void {
    this.transport.write(JSON.stringify(message))
  }

  private writeError(id: number | string | null, code: number, message: string, data?: unknown): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
  }

  private async handleLine(line: string): Promise<void> {
    const parsed = parseRequestLine(line)
    if ('error' in parsed) {
      this.write(parsed.error)
      return
    }
    const request: JsonRpcRequest = parsed.request
    const method = this.methods.get(request.method)
    if (!method) {
      this.writeError(request.id, RPC_ERROR.methodNotFound, `method not found: ${request.method}`)
      return
    }
    try {
      const result = await method(request.params ?? {})
      this.write({ jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      if (error instanceof RpcInvalidParamsError) {
        this.writeError(request.id, RPC_ERROR.invalidParams, error.message)
      } else {
        this.writeError(request.id, RPC_ERROR.internal, error instanceof Error ? error.message : String(error))
      }
    }
  }
}

