# 工具执行取消与日志结算

> 状态：Accepted（2026-08-24）。这是 S4.3b 的工具执行取消契约。

## 1. 问题与边界

模型流取消已经存在，但旧 Tool 契约只有 `execute(args)`。模型一旦完成工具调用并进入 `bash`、文件操作或审批等待，`Loop.cancel()` 无法中断执行，已经记录的 `tool/call` 也可能缺少对应结果。

S4.3b 将一次工具执行定义为：

```ts
execute(args, { signal })
```

`ToolExecutionContext` 首版只包含 `AbortSignal`。审批、预算、沙箱身份等产品策略不进入该上下文，也不向 Loop 增加产品条件分支。

## 2. 信号路径

取消信号沿同一条调用链传递：

```text
CLI Ctrl-C / SDK session.cancel
  -> SessionRuntime.cancel
  -> Loop.cancel
  -> ToolExecutionContext.signal
  -> approval prompt / fs tool / subprocess provider
```

- CLI 第一次 `Ctrl-C` 发起协作式取消，完成日志结算后以 130 退出；第二次仍保留操作系统的强制退出行为。
- `session.cancel` 只取消该会话当前正在运行的 turn，不删除会话，也不取消排队或未来的 run。
- 交互审批的 readline 等待使用同一 signal；取消后不会继续等待用户输入，更不会执行批准前的副作用。

## 3. 事实日志结算

模型返回的全部工具调用会先记录为 `tool/call`，再按顺序执行。取消可能发生在其中任意位置，因此结算规则固定为：

| 调用状态 | `tool/result` |
|---|---|
| 取消前已经完成 | 保留真实成功或失败结果 |
| 正在执行时取消 | `ok: false`，输出 `cancelled` |
| 已记录但尚未执行 | `ok: false`，输出 `cancelled before execution` |

所有已记录的调用都有结果后，Loop 追加 `step/end` 和 `turn/end`，不再发起下一次模型请求。这里复用现有 10 种 SessionEvent，不新增取消事件，也不把实时 AbortSignal 写进日志。

## 4. Provider 责任

- 文件工具在读取前以及写入副作用前检查 signal；取消不是事务，已经完成的写入不会自动回滚。
- `LocalSubprocess` 在 Unix 上为 Shell 创建独立进程组；取消先发 `SIGTERM`，随后用 `SIGKILL` 收束忽略终止信号的后代，并等待 close 后才结算。
- 命令超时也终止同一进程组，避免只杀 Shell、留下后台任务。
- Windows 没有同等的负 PID 进程组语义，首版退化为终止直接子进程；完整进程树隔离留给 P5 Docker provider。

## 5. 非目标

- 不提供文件系统事务或副作用回滚；
- 不恢复模型失败造成的未闭合 step；
- 不持久化“谁按了取消”或取消原因 provenance；
- 不用取消替代审批、权限或 Docker 沙箱；
- 不在本步实现 session resume、自动压缩或任务预算。
