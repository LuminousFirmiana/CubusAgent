import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { RpcTransport } from './transport.ts'

/**
 * stdio 传输：stdin 逐行读请求，stdout 逐行写响应（一行一个 JSON）。
 * 与内存传输同一个接口 —— 传输抽象的第二实现。
 */
export function createStdioTransport(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
) {
  let handler: ((line: string) => void) | undefined
  const rl = createInterface({ input, crlfDelay: Infinity })
  rl.on('line', line => {
    handler?.(line)
  })
  return {
    write(line: string) {
      output.write(line + '\n')
    },
    onRequest(h: (line: string) => void) {
      handler = h
      return () => {
        handler = undefined
      }
    },
    close() {
      rl.close()
    },
  }
}

