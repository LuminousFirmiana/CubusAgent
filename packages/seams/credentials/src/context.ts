// 必须显式导入被增强的模块（交接文档坑 #22）。
import '@cubus/cordis'
import type { CredentialsProvider } from './types.ts'

declare module '@cubus/cordis' {
  interface Context {
    credentials: CredentialsProvider
  }
}
