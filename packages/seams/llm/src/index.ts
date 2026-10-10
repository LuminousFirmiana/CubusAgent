/**
 * @cubus/llm 是**接缝**：只有契约（接口 + 错误）与一个测试替身。
 *
 * 真实 provider 住在 packages/providers/*（例如 @cubus/llm-deepseek）——
 * "缝里不住实现"这条一致性由 @cubus/architecture-guard 的层次规则守着。
 */
export * from './types.ts'
export * from './errors.ts'
export * from './scripted.ts'
