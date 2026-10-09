// 必须显式导入被增强的模块：只写 declare module 而不 import 时，
// TypeScript 会把它当成新的模块声明，破坏别处已有的 Context 合并（交接文档坑 #22）。
import '@cubus/cordis'
import type { SandboxProvider } from './types.ts'

declare module '@cubus/cordis' {
  interface Context {
    sandbox: SandboxProvider
  }
}
