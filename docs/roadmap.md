# CubusAgent 路线图：把四条产品声明变成可验证事实

> 建立于 HEAD 6895939（19 包 / 109 测试）。本文件与 `docs/handover.md` 配套：handover 说
> "现在在哪"，本文件说"接下来按什么顺序做到哪"。

## 0. 方法：声明 -> 可验证证据

原产品声明的问题不在于方向，而在于**用了无法验证的量化口径**（60-70%、40%、95%）。
本路线图的每个阶段都必须产出一个**可执行、可复现、可归档**的证据，替代数字：

| 类型 | 证据形态 |
|---|---|
| 能力存在 | 包 + 接口 + 行为测试（假实现确定性 + 真实现端到端） |
| 解耦成立 | "换 X 不改 Y"的 diff 断言 + 同协议双实现验收 |
| 安全成立 | 越界/越权/超限的**拒绝测试**（不是提示词，不是警告） |
| 可复现 | 会话日志回放 + golden trajectory 对比 |
| 可运维 | resume/结算/备份的崩溃-重启测试 |

## 1. 声明与缺口的对应关系

| 声明 | 已有 | 缺口（本路线图要补） |
|---|---|---|
| ① 产品契约与插件复用 | 3 个 recipe、typed Host/Recipe、会话/循环/模型/工具注册/审批均为插件、S3.5 换 recipe 不改内核验收 | manifest 只有 id/version/displayName；提示词/工具/权限是代码挂载非声明；UI 不在契约；评测未入契约 |
| ② 运行环境解耦 | Host 提供模型与会话存储；fs/subprocess seam 存在；provider 替换触发重挂 | 无 capability 需求声明与协商；沙箱/凭据不由 Host 提供；fs/subprocess 在 plugins 而非 Host |
| ③ 行为验证与任务恢复 | 事件溯源完整；eval harness；审批在 CLI | Eval Suite 未成为产品契约；无工作台（任务/差异/审批/恢复视图）；无 resume/settlement；无回归门禁 |
| ④ 执行隔离与资源治理 | 逐工具审批 ask/allow/deny；子进程凭据清洗；trust 闸门；同会话串行化 | **无 Docker 沙箱**；**无预算上限**；无有界并发；无统一执行边界；无拦截率指标 |

## 2. 阶段划分与依赖

```
A(P4收尾) ──> B(契约声明式化) ──> C(P5共享安全层) ──> E(P6工作台) ──> F(P7个人交付)
                    │                    │                ▲
                    └──> D(验证与恢复) ───┴────────────────┘
```

- **A -> B 强依赖**：契约要声明"权限/评测/UI"之前，先要有差异报告与实时事件作为可声明的对象。
- **B -> C 强依赖**：沙箱与凭据是 Host 能力，必须先有 capability 需求声明与协商机制。
- **D 可与 C 并行**：Eval Suite 契约化与 resume 只依赖 B；但 resume 的副作用语义需要 C 的凭据/沙箱边界结论，因此 D 的最后一步排在 C 之后。
- **E 依赖 A2（实时事件）与 D（回归）**：工作台是日志投影的消费者，必须先有稳定事件流与恢复语义。
- **F 依赖 C/E**：可观测指标要在沙箱与工作台之后才有意义。

每步一个锁点（仓库纪律）：本地 `pnpm install --frozen-lockfile` + `pnpm run check` 通过 ->
显式提交 -> push -> **CI 全绿** -> 更新 `docs/handover.md` -> 才允许开始下一步。

## 3. 阶段 A：P4 收尾（3 步，规模 S/M/S）

| 步 | 目标 | 交付 | 验收证据 |
|---|---|---|---|
| A1 ✅ | S4.4 Git 变更报告（已完成） | git 只读 provider/service；CLI 输出基线 diff 摘要 | 干净仓库/已有改动/新增文件/非 git 目录四类测试 |
| A2 ✅ | CLI 实时事件渲染 | SDK 事件流 -> CLI（chunk 打字、工具卡片、取消提示） | 真实子进程 e2e：断言顺序与退出码 |
| A3 ✅ | 评测基线扩充 | fixtures 增至 5-8 个；真模型夜跑脚本产出 `EVALS.md` | 假模型全绿 + 真模型分数表归档 |

## 4. 阶段 B：契约声明式化与能力协商（4 步，规模 M/L/M/S）

| 步 | 目标 | 交付 | 验收证据 |
|---|---|---|---|
| B1 ✅ | **ADR**：Recipe 声明式契约 + Host 能力解析 | `docs/design/recipe-capabilities.md` | 明确哪些进 manifest、哪些留在代码挂载；step 能力快照语义不变 |
| B2 ✅ | manifest 扩展 | `capabilities.requires`、prompt 片段 id、tool 能力名、审批策略名、eval suite 引用、UI 呈现意图 | 类型 + 校验（缺失/冲突装配期 fail-loud）+ 单测 |
| B3 ✅ | Host 能力装配与协商 | 由 requires 解析 provider；装配结果（recipe 身份 + 能力快照）写入会话日志 | 缺 provider 拒装配；同 recipe 换 Host 零 recipe 改动（diff 断言） |
| B4 ✅ | 迁移现有 3 个 recipe | reference/coding/repair-eval 改为声明式 | 保留 S3.5 验收：换 recipe 不改 session/loop/Host/SDK |

**关闭声明 ①② 的核心**：recipe 声明需求、Host 提供能力；新增产品 = 新增 recipe 包 + 0 行内核改动（用 diff 断言证明，而非百分比）。

## 5. 阶段 C：P5 共享安全层（6 步，规模 L/L/M/L/M/M）

| 步 | 目标 | 交付 | 验收证据 |
|---|---|---|---|
| C1 ✅ | **ADR**：沙箱 seam 与凭据最小暴露模型 | `docs/design/sandbox-seam.md` | fs/subprocess/sandbox 三角边界；Docker provider 契约 |
| C2 ✅ | sandbox seam + local provider | 显式"无隔离"实现 + 能力声明接入 Host | 装配期可见"本 Host 不隔离"；测试断言 |
| C3 ✅ | credentials provider | 凭据引用（非明文）+ env/.env provider + 注入最小集合 + 审计事件 | 容器/子进程内探不到宿主凭据（拒绝测试） |
| C4 ✅ | **Docker sandbox provider** | 每会话容器、工作区挂载边界、网络默认关、资源上限 | 越界写/外网访问/逃逸尝试全部被拒；同 recipe 在 local 与 docker 下行为测试一致 |
| C5 ✅ | 预算策略 | tokens/步数/时长/费用上限插件；step 边界与流中断点强制 | 超限任务被取消且日志完整结算（测试） |
| C6 ✅ | 有界并发与队列 | Host 级并发上限、排队与超时 | 超限排队测试 + 公平性/超时测试 |

**关闭声明 ④ 的核心**：沙箱、凭据、预算、并发四件，全部以"拒绝测试"为证据。

## 6. 阶段 D：行为验证与恢复（4 步，规模 M/M/L/M）

| 步 | 目标 | 交付 | 验收证据 |
|---|---|---|---|
| D1 ✅ | **ADR**：Eval Suite 作为产品契约 + 恢复语义 | `docs/design/eval-suite-and-resume.md` | suite 格式、判定、golden trajectory、可重放/不可重放副作用的区分 |
| D2 ✅ | Eval Suite 实现 | recipe 引用 suite；runner 跑全套；结果落日志 | CI 无 key 门禁（假模型）+ 夜跑真模型 |
| D3 ✅ | 会话 resume 与未闭合 turn 结算 | 从日志恢复；settlement 语义 | kill 进程 -> 重启 -> 状态与日志一致（崩溃恢复测试） |
| D4 ✅ | 评测集扩至 30-50 任务 + 回归对比 | golden trajectory diff 门禁 | 改 prompt/工具导致回退时门禁变红（自证有效） |

**关闭声明 ③ 的前半**：Eval Suite 入契约、行为回归、问题定位（回放）。

## 7. 阶段 E：P6 工作台（6 步，规模 M/M/L/L/M/M）

| 步 | 目标 | 交付 | 验收证据 |
|---|---|---|---|
| E1 ✅ | **ADR**：工作台事件流协议 | `docs/design/workbench-protocol.md` | 选 SSE 或 WebSocket；UI 只读日志投影；无状态 |
| E2 ✅ | 事件流服务端 | 会话事件流 + 鉴权 + 断线重连 | 重连后事件不丢不重（协议测试） |
| E3 ✅ | Web UI 骨架 | 会话列表 + transcript 回放（chunk 打字机 + 工具卡片） | 中途刷新页面渲染一致（**UI 无状态验收**） |
| E4 ✅ | 任务与差异视图 | 复用 A1 的 git diff provider | 与 CLI 输出一致 |
| E5 ✅ | 审批交互 | Web 端 ask/allow/deny + 超时默认拒绝 | 三分支 + 超时 e2e |
| E6 ✅ | 恢复视图 | resume 入口 + 未闭合 turn 可视化结算 | 与 D3 语义一致 |

**关闭声明 ① 的 UI 部分与 ③ 的工作台部分**。

## 8. 阶段 F：P7 个人交付与可观测（5 步，规模 S/M/M/M/S）

| 步 | 目标 | 交付 | 验收证据 |
|---|---|---|---|
| F1 🔶 | 单机安装与启动 | 一键安装 + 配置生成 + 启动脚本 | 干净机器安装-运行-卸载 e2e |
| F2 ✅ | 重启恢复 | 进程重启后会话续跑 | 重启-续跑测试 |
| F3 | 备份与格式版本 | 日志归档 + `SESSION_FORMAT_VERSION` 信封 | 跨版本读取/拒绝测试 |
| F4 | **观测指标** | 拦截率、取消率、重试率、每任务耗时与成本 | 指标可从日志计算（**量化陈述从此有数据支撑**） |
| F5 | 可选 PR/通知集成 | GitHub/IM 通知作为产品扩展 | 端到端一次通知 |

**F4 是把"95% 拦截率"这类数字变成事实的唯一途径**：先有沙箱与预算，再有指标，最后才是数字。

## 9. 明确不做（保持部署克制）

- K8s / CRD / Operator / 多租户 / GPU 调度：无真实负载前不建（Kthena 只作设计输入）。
- 不把审批、预算、沙箱塞进 Loop：它们必须挂在 seam/policy 上。
- 不让 Web 入口反向定义内核：工作台只是日志投影的消费者。
- 不用提示词或命令分类冒充安全边界：真正的隔离只有 Docker/凭据/默认拒绝。

## 10. 节奏与并行建议

- 总规模：**28 步**（A3 + B4 + C6 + D4 + E6 + F5）。
- 可与主序并行：D 与 C 并行（不同包、无文件冲突）；A2 与 A3 并行。
- 每步一个锁点；每阶段收尾更新 `docs/handover.md` 并把声明证据补进本文件对应表格。
- 每阶段结束时用一句话回答"哪条声明现在有了可验证证据"，没有证据的阶段不算完成。
