/**
 * git seam 的 Service Definition：工作区版本状态的只读检查。
 *
 * 消费方（CLI 的变更报告）只依赖这些类型，不依赖具体实现。
 * 实现必须只读：不提交、不暂存、不回滚、不生成 PR。
 */

/** 工作区里一个文件在某一时刻的状态（git status 的语义化投影）。 */
export interface GitFileState {
  /** 相对仓库根的路径。 */
  readonly path: string
  /** porcelain 两列状态码，例如 ' M'、'??'、' D'。 */
  readonly status: string
  /** 文件内容哈希；文件不存在（已删除）时为 null。 */
  readonly hash: string | null
}

/** 一次运行开始前记录的工作区基线；不要求工作区干净。 */
export interface GitBaseline {
  readonly isRepository: boolean
  /** HEAD 提交 sha；空仓库（尚无提交）为 null。 */
  readonly head: string | null
  /** 基线上已经存在的改动 —— 用户原有未提交改动。 */
  readonly files: readonly GitFileState[]
}

/** 相对基线发生的变化类别。 */
export type GitChangeKind = 'created' | 'modified' | 'deleted' | 'restored'

/**
 * 本次运行改变的一个文件。
 *
 * "哪些文件被动过"由基线与当前内容哈希对比判定（保留用户原有改动的边界）；
 * 但 addedLines / removedLines 是相对 HEAD（提交状态）的行数统计 ——
 * 不修改仓库就拿不到基线内容快照，因此同一文件上的用户既有改动会被计入。
 * 只关心"改了哪些文件"时看 changed 列表，不关心行数归属时看这两个字段。
 */
export interface GitChangedFile {
  readonly path: string
  readonly kind: GitChangeKind
  /** 相对 HEAD 的新增行数；无法计算（二进制、/dev/null 不可用）时为 null。 */
  readonly addedLines: number | null
  /** 相对 HEAD 的删除行数；无法计算时为 null。 */
  readonly removedLines: number | null
}

/** 相对基线的变更报告。 */
export interface GitChangeReport {
  readonly isRepository: boolean
  readonly head: string | null
  /** 本次运行改变的文件（按路径排序）。 */
  readonly changed: readonly GitChangedFile[]
  /** 基线上已存在、本次未再改动的文件 —— 用户原有改动（按路径排序）。 */
  readonly preexisting: readonly string[]
  /**
   * 人类可读摘要（确定性排序）。
   * 渲染方直接输出这些行，不要自行拼接 Git 语义。
   */
  readonly summary: string
}

/** 单次只读探测的可选取消信号（与 Tool.execute 的取消约定一致）。 */
export interface GitProbeOptions {
  readonly signal?: AbortSignal
}

/**
 * 只读 Git 工作区检查。
 * 非 Git 目录不报错：以 isRepository: false 表达。
 * 实现若收到 signal，必须在命令边界检查取消。
 */
export interface GitWorkspaceProvider {
  /** 记录运行前基线。 */
  baseline(dir: string, options?: GitProbeOptions): Promise<GitBaseline>
  /** 生成相对基线的变更报告；必须不改变仓库状态（含索引）。 */
  report(dir: string, baseline: GitBaseline, options?: GitProbeOptions): Promise<GitChangeReport>
}
