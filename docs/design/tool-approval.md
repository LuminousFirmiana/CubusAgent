# 工具审批 Seam

> 状态：Accepted（2026-08-24）。这是 S4.2 的最小审批边界，不是执行沙箱。

## 1. 目标

在 Coding Agent 日常入口中，任何工具执行都必须经过 Host 提供的 policy seam。Recipe 决定哪些工具需要审批，CLI 决定如何询问用户；Loop 仍只驱动“模型调用 -> 工具调用 -> 工具结果”，不认识 ask/allow/deny。

## 2. 契约

```ts
interface ToolApprovalRequest {
  toolName: string
  args: unknown
}

interface ToolApprovalDecision {
  outcome: 'allow' | 'deny'
  reason?: string
}

interface ToolApprovalService {
  decide(request: ToolApprovalRequest): Promise<ToolApprovalDecision> | ToolApprovalDecision
}
```

Host 提供 `ToolApprovalService`；Coding Recipe 在注册 read/edit/write/bash 时用统一 wrapper 包装执行器。缺少审批 provider 时，Coding Recipe 挂载失败，不能静默回退到 allow-all。

## 3. 日志与审计

不修改 SessionEvent 词汇：

1. Loop 先记录 `tool/call`，其中已有工具名与完整参数；
2. wrapper 再请求审批；
3. deny 抛出明确的 policy 错误，由 Loop 记录为 `tool/result ok:false`；
4. allow 才执行工具；成功结果证明调用已获允许，执行异常会标明“已允许但执行失败”。

审批提示和用户按键不进入模型上下文；模型只看到已记录的 tool result，继续满足“模型可见当且仅当已记录”。当前日志可以审计 allow/deny 对执行的影响，但不记录审批人、规则版本或交互原文；若产品需要这些 provenance，必须单独讨论新事件与格式迁移。

## 4. CLI 模式

- `ask`：默认。交互终端逐次询问；非交互环境默认 deny；
- `allow`：显式放行所有本次任务工具，仅用于用户主动选择的受信工作区或自动评测；
- `deny`：拒绝所有工具，模型仍可收到失败结果并收束回复。

`--trust-workspace` 与审批是两层不同确认：前者允许启动这个本地产品，后者决定每次具体工具调用。两者都不是 Docker 隔离。

## 5. 验收

1. Coding Recipe 缺少审批 provider 时挂载失败；
2. deny 决策不触碰底层工具，失败结果进入会话日志并回传模型；
3. allow 决策只执行一次底层工具；
4. CLI ask 在非 TTY 下默认拒绝，在交互确认后允许；
5. repair eval 显式使用 allow provider，现有真实任务链不回归；
6. 不修改 Loop 与 SessionEvent。
