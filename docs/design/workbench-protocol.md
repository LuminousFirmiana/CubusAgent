# 工作台事件流协议

> 状态：Accepted（2026-10-09）。对应 roadmap E1（ADR）与 E2（事件流服务端，已实现）。
> 说明：本 ADR 是在服务端落地**之后**补齐的（顺序不理想，如实记账）：实现与下面的决定一致，
> 未发现需要回退之处；如决定改为 WebSocket，改动范围限于 `packages/apps/workbench/src/server.ts` 一个模块。

## 1. 要解决的问题

工作台要让人**看见正在发生什么**：一次修复任务里，模型请求了哪些工具、日志里落了什么、花了多少 token、
崩了之后能不能接着跑。约束来自既有架构：

1. 会话日志是**唯一事实源**（宪法）；工作台不得维护影子状态，界面显示的一切必须能从日志重建；
2. 会话内串行、跨会话有界并发（S2.3a / C6）；
3. 恢复语义已有（D3）：未闭合区间可结算、装配身份不一致则拒绝。

## 2. 传输选型：SSE（而不是 WebSocket）

| 方案 | 优 | 劣 | 结论 |
|---|---|---|---|
| **SSE（选定）** | 单向"日志 -> 浏览器"正好匹配；原生重连 + `Last-Event-ID` 续传；纯 HTTP，无握手/心跳协议要设计；`curl -N` 就能调试 | 只能服务端推；需要 HTTP/1.1 长连接（本地无碍） | **采用** |
| WebSocket | 双向 | 需要自己设计重连/续传/心跳；本地场景没有上行需求（运行/恢复都是普通 POST） | 不采用 |
| 轮询 | 实现最简单 | "正在发生什么"的实时性差；事件多时浪费 | 不采用 |

**上行操作（创建/运行/恢复）走普通 JSON POST**，因此不需要双向通道。

## 3. 端点契约

```
GET  /                          端点清单（纯文本）
GET  /api/concurrency           名额占用与排队（C6）
GET  /api/sessions              会话摘要列表（新在前）
POST /api/sessions              创建会话 -> 201 { session: { id, logPath } }
GET  /api/sessions/:id          摘要 + 装配快照 + 预算状态 + 最近一次运行状态
POST /api/sessions/:id/run      { task } -> 202（异步；事件走 SSE）
GET  /api/sessions/:id/events   SSE 事件流（见 §4）
GET  /api/sessions/:id/changes  本次运行的改动报告（只读 Git，见 §9）
POST /api/sessions/:id/resume   恢复（D3 语义）-> 200 { formatVersion, settled, settlementEvents }
```

**状态码语义**（客户端据此区分"该重试还是该放弃"）：

| 码 | 含义 |
|---|---|
| 400 | 参数不合法（缺 task、JSON 坏） |
| 404 | 会话或端点不存在 |
| 409 | **不能恢复**：日志格式版本过高、缺装配快照、装配身份与原会话不一致；或同一会话已有运行在飞 |
| 413 | 请求体过大（上限 1 MB） |
| 500 | 其它错误 |

## 4. 事件流：不丢不重的续传

每条事件帧带 `id: <日志下标>`（0 起、append-only 的位置）：

```
id: 7
event: session-event
data: {"type":"tool/call","id":"c1","name":"read_file",...}
```

**连接建立的三步**（服务端实现，保证不丢不重）：

1. 先读一次日志，记下基线长度 `N0`；
2. **订阅**（此后写入的每个事件先进缓冲），再读一次拿快照 `N`（`N >= N0`）；
3. 回放快照（跳过 `id <= Last-Event-ID` 的部分），再补发缓冲里"快照之后"的那一段（即 `N - N0` 之后的部分）。

正确性依据：日志 provider 是**单写者**，且 `append` 先落盘、再**同步**广播给监听者
（`packages/providers/session-jsonl/src/log.ts`）。因此"订阅早于第二次读"覆盖了全部并发写入，
而"两次读的长度差"精确给出了缓冲里已被快照包含的事件数。

**断线重连**：客户端带 `Last-Event-ID: <最后收到的 id>` 重连即可续传（浏览器 `EventSource` 自动带上）。

## 5. 两类帧

| 帧 | 是否落盘 | 用途 |
|---|---|---|
| `session-event` | **是**（日志事件，带 id） | 界面显示的唯一内容来源 |
| 控制帧（`run-state` / `session-resumed`，无 id） | 否，**短暂** | 运行开始/结束、恢复结算的即时提示 |

**控制帧是易失的**：连得晚的客户端看不到已经发生过的控制帧，它应当从**日志**（`turn/start`…`turn/end`）
或 `GET /api/sessions/:id` 里的 `run` 字段取状态 —— 这与"日志是唯一事实源"一致，界面不得依赖控制帧才能正确。

## 6. 鉴权与暴露面（v1 的诚实边界）

- 服务**默认只监听 `127.0.0.1`**；工作台是本地工具，不是公网服务；
- **v1 不做鉴权**：回环地址上的任何本地进程都能调用它（与 CLI 在本机的能力等价）；
- 要把工作台暴露到回环之外，必须先补齐：令牌鉴权、CSRF/Origin 校验、审批档强制 ask、TLS 终止 —— 在此之前不得改默认监听地址。

## 9. 改动报告（E4）

GET /api/sessions/:id/changes 返回本次运行的改动（只读 Git 报告）：

- 服务端在 POST …/run 开始前记录一次 Git 基线（内存里只有基线，不缓存报告）；
- 请求时按需计算：当前工作区 - 基线；
- 没有工作区（服务未配置）-> 409 started without a workspace；没有跑过 -> 409 no run has been recorded；
- 非 git 工作区返回 isRepository: false（诚实表达不知道，而不是给一份空报告）。

与 CLI 同源：两者都用 A1 的 GitCliWorkspaceProvider 与同一段 summary 渲染，因此输出格式一致。

## 7. 不做的事（非目标）

- 不做影子状态/本地事件缓存：界面刷新 = 重新回放日志；
- 不做多写者或事件改写：日志 append-only，工作台只读；
- 不做双向通道上的工具审批（E5 会做，届时走 POST + 页面响应，仍不走 SSE 上行）；
- 不在服务端渲染 transcript（E3 由前端按 chunk/工具卡片投影）。

## 8. 验收（已实现）

| 验收 | 证据 |
|---|---|
| 实时可见 | 测试：创建 -> 订阅 -> 运行，流里出现 `session/mount`、`tool/call`、`tool/result`、`turn/end` |
| 不丢不重 | 测试：`id` 连续且从 0 开始；带 `Last-Event-ID` 重连后收到 `[resumeFrom+1 .. N-1]` |
| 恢复可见 | 测试：崩溃尾巴 -> `needsSettlement` 为 true -> `POST resume` 返回结算事件；无装配快照 -> 409 |
| 参数错误不崩 | 测试：缺 task 400、坏 JSON 400、未知会话 404、未知端点 404 |
| 真实可用 | 手工：`pnpm run workbench:demo` + `curl -N` 看到 15 条事件帧 + 2 条控制帧 |
