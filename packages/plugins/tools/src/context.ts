// 必须显式导入被增强的模块：只写 declare module 而不 import 时，
// TypeScript 会把它当成新的模块声明，破坏别处已有的 Context 合并
// （表现为其它包的 ctx.provide 突然"不存在"）。踩过一次。
import '@cubus/cordis'
import type { FsProvider } from './fs.ts'
import type { SubprocessProvider } from './subprocess.ts'

/**
 * Host 提供的环境能力服务键（B4）。
 *
 * 声明放在能力类型的归属包：Host（提供方）与 Recipe（消费方）共享同一份类型。
 * workspaceDir 不是"能力"而是环境事实：Host 随 fs/subprocess 一起提供，
 * Recipe 在 mount 时读取，缺失即装配失败（不是可选能力）。
 */
declare module '@cubus/cordis' {
  interface Context {
    fs: FsProvider
    subprocess: SubprocessProvider
    workspaceDir: string
  }
}
