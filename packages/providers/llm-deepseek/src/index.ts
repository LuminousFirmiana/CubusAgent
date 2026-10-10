/**
 * @cubus/llm-deepseek：DeepSeek provider（一次请求 + 一次响应解析）与它的接线。
 *
 * 显式导出（P1 规则）：新公开名字必须加进本清单；
 * 内部路径（./deepseek.ts 等）不是 API，消费者从包名导入。
 */
export { DeepSeekAdapter } from './deepseek.ts'
export type { DeepSeekConfig, Transport } from './deepseek.ts'
export {
  createDeepSeekAdapterFactory,
  loadDeepSeekEnvFile,
  MODEL_CREDENTIAL_NAME,
  readDeepSeekEnvironment,
} from './wiring.ts'
export type { DeepSeekEnvironment } from './wiring.ts'
