# LLM 错误分类与有界重试

> 状态：**Accepted，但实现已迁移**（2026-10-09，P1）。
> 语义（错误分类 + 只重试"还没产出 chunk 的瞬时失败" + 有界退避）保持不变，但实现从独立的
> `@cubus/policies/llm-retry` 包**搬进了循环**（`@cubus/agent-loop` 的 retry.ts，F4b）：
> 重试是**请求事实**，必须写进会话日志（`request/retry`），两层包装会让重试不可见。
> 旧包已删除，本文件保留为决策历史。
> 实现：**决策历史** —— 语义仍在用（错误分类 + 只重试未产出 chunk 的瞬时失败），但实现已搬进 @cubus/agent-loop；独立包已删除。

## 1. 边界

Provider 负责把远端事实归一化为 typed `LlmError`：错误种类、是否可重试、可选 HTTP status。Retry policy 只读取 `retryable`，不解析错误字符串，也不包含 DeepSeek 状态码分支。Loop 不处理供应商重试。

首版分类：

- HTTP 429：`rate-limit`，可重试；
- HTTP 5xx：`server`，可重试；
- fetch/流读取网络失败：`network`，可重试；
- 401/403：`authentication`，不可重试；
- 其他 4xx：`request`，不可重试；
- 坏 SSE/协议内容：`protocol`，不可重试。

## 2. 重试安全线

同一个 step 的 request/header 只记录一次，policy 可以在模型尚未产出任何 chunk 时重发完全相同的请求。

一旦 adapter 已经 yield 正文、思考或 tool call，policy 不得重试。此时日志已有模型输出前缀，重试会重复正文或副作用意图；首版原样抛错，留给后续 session 恢复设计。

## 3. 退避与取消

- 默认最多 3 次总尝试；
- 默认 500ms 起步、2 倍指数退避、上限 5s；
- 仅重试明确标记 `retryable` 的 `LlmError`；
- abort 会立即中断请求或退避等待；
- CLI 可设置总尝试次数，但不能配置无限重试。

Retry attempt 是 transport 行为，不进入模型上下文。当前没有新增 session 事件记录 attempt；未来如需运维遥测，使用非模型可见的观测扩展点，不能伪装成对话事件。
