/** 沙箱边界特性：每一项都是可验证的断言，不是形容词（见设计文档 §4）。 */
export const SANDBOX_FEATURES = [
  /** 显式声明"没有隔离"——需要隔离的需求永远不会匹配它。 */
  'unconfined',
  /** 工作区之外不可见 / 不可写。 */
  'fs-isolation',
  /** 无网络出口。 */
  'network-deny',
  /** CPU / 内存 / PID / 磁盘上限。 */
  'resource-limits',
  /** 进程与宿主隔离（独立 PID namespace）。 */
  'pid-isolation',
] as const

export type SandboxFeature = (typeof SANDBOX_FEATURES)[number]
