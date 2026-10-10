/**
 * SDK 的**公开面**（P1）：这里是显式导出清单，不是 export *。
 *
 * 规则（见 docs/design/versioning.md）：
 * - 只有列在这里的名字算公开 API；新增公开名字必须显式加进本文件（评审时看得见）；
 * - 内部路径（./xxx.ts）不是 API，外部使用者只能用包名 @cubus/sdk 导入；
 * - 公开面变动属破坏性变更：改名/删除/改语义要升 minor 并在文档里记迁移；
 *   新增可选字段/新增函数属 additive，可直接进 minor。
 *
 * packages/support/architecture-guard 会检查本文件不再出现 export *。
 */
export type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcSuccess,
  JsonRpcError,
  JsonRpcMessage,
} from './protocol.ts'
export { RPC_ERROR } from './protocol.ts'
export type { RpcTransport } from './transport.ts'
export { createMemoryTransport, parseRequestLine } from './transport.ts'
export { createStdioTransport } from './stdio.ts'
export type { RpcMethod } from './server.ts'
export { RpcInvalidParamsError, RpcServer } from './server.ts'
export { ConcurrencyGate, QueueTimeoutError } from './concurrency.ts'
export type { ConcurrencySnapshot } from './concurrency.ts'
export { listSessions, readSessionEvents, readSessionSummary } from './sessions.ts'
export type { SessionSummary } from './sessions.ts'
export { collectMetrics, sessionMetrics, summarizeMetrics } from './metrics.ts'
export type { MetricsSummary, SessionMetrics } from './metrics.ts'
export {
  applyPrune,
  ArchiveError,
  ARCHIVE_FORMAT_VERSION,
  ARCHIVE_MANIFEST,
  ARCHIVED_FILES,
  exportSessions,
  importSessions,
  parseArchiveManifest,
  planPrune,
} from './archive.ts'
export type { ArchivedFile, ArchivedSession, ArchiveManifest, ImportResult, PrunePlan } from './archive.ts'
export { createRunnerMethods, SessionRuntime } from './runner.ts'
export type { ResumeOptions, ResumeResult, RunResult, SessionInfo, SessionRuntimeOptions } from './runner.ts'
