# CubusAgent 交接文档

> 最后更新：D2 Eval Suite 显式制品化完成（D1 ADR 已 Accepted）。本文件是"接手这个项目的第一份读物"。

## 1. 这个项目是什么

**CubusAgent**：基于 Cordis 底座、吸收 DeepSeek Harness（DSH）理念构建的**通用 Agent 原型与产品化框架**。内核不预设“编码”角色；模型、提示词、工具、记忆、权限、沙箱、交互界面和任务驱动都应通过插件参与组合。

它没有唯一的“最终 Agent”，而是三层关系：

1. **通用 Agent 原型**：会话事实源 + agent loop + LLM seam + 插件生命周期，证明任意 Agent 都能在这套机制上运行；
2. **产品 profile**：用不同插件组合成 Coding Agent、研究 Agent、自动化 Agent 等具体产品，彼此不 fork 内核；
3. **Agent 工作台**：进一步产品化的宿主，负责选择/管理 profile、会话、任务、审批、可视化和恢复。官方工作台仍以个人单机、自托管、自带凭据为默认部署边界。

修 bug 的 Coding Agent 评测只是第一条高强度纵向验收链，用来证明内核真的能调用工具完成外部任务；它不是 CubusAgent 的产品定义。

当前阶段（v1.0 开发中）：**通用原型已毕业，正式 Coding Agent 已有可运行 CLI、逐工具审批、模型暂态重试和端到端取消，下一步补 Git 变更报告**。技术路线：自研内核 + vendored cordis 底座（B 路线，决策记录见第 6 节）。

## 2. 当前状态总览

| 阶段 | 状态 | 内容 |
|---|---|---|
| P0 地基 | 完成 | monorepo + 工具链 + CI + vendored cordis |
| P1 内核 | 完成 | 会话日志（宪法）+ turn/step 循环 + llm seam + cordis 插件化 |
| P2 原型纵向验收 | 完成 | JSON-RPC SDK + 通用 loop + 真实修 bug 任务（passed: true，作为能力证明） |
| S2.3a 参考同步 | 完成 | reference 更新审计 + 模型子进程凭据隔离 + SDK 同会话串行化 |
| S2.3b 内核锁定 | 完成 | 完整模型请求可重建 + DeepSeek reasoning passback |
| S3.0 装配契约 | 完成 | Agent Host / Recipe ADR + step 能力快照边界 + P3 非目标 |
| S3.1 Prompt Service | 完成 | prompt fragment 注册、确定性排序/组装、重复拒绝、生命周期撤销 |
| S3.2 Tool Registry | 完成 | 独立 Tool 契约 + 确定性注册表 + 生命周期撤销 + 每 step 能力快照 |
| S3.3 Session Provider | 完成 | core 只定义 SessionLog seam；JSONL 持久化由 Host provider 提供 |
| S3.4 Recipe / Host 装配 | 完成 | typed manifest + Host/Recipe/Loop 固定装配顺序 + 整棵生命周期回卷 + SDK 迁移 |
| S3.5 双 Recipe 验收 | 完成 | reference-agent 非 coding 工具闭环 + repair-eval 纵向验收 + 同协议切换不改内核 |
| P3 通用原型毕业 | 完成 | 通用机制、环境 Host、产品 Recipe 三层分离；all is plugin 已有可执行证据 |
| S4.0 Coding 产品契约 | 完成 | CLI/Recipe/Host 职责 + 受信工作区边界 + 日志外置 + P4 非目标 |
| S4.1 Coding CLI | 完成 | 正式 coding-agent Recipe + 任务/工作区 CLI + trust 强制确认 + 进程级验收 |
| S4.2 工具审批 | 完成 | Host policy seam + Coding 工具统一包装 + CLI ask/allow/deny + 非交互默认拒绝 |
| S4.3a 模型暂态容错 | 完成 | typed LLM 错误 + adapter 重试 wrapper + 有界指数退避 + abort-aware 等待 |
| S4.3b 工具执行取消 | 完成 | Tool signal 上下文 + 审批取消 + 进程组终止 + 完整日志结算 + CLI/SDK 入口 |
| S4.4 Git 变更报告 | 完成 | 只读 Git seam/provider（seams/git + providers/git-cli）+ 基线-报告边界 + CLI 输出 |
| S4.5 CLI 实时渲染 | 完成 | SessionLog 订阅 seam + SDK subscribe + CLI 实时输出（chunk 逐行、工具卡片、结果行） |
| S4.6 评测 fixtures | 完成 | 7 个修复任务 fixture（7 类 bug）+ fixture.json 自描述 + 无 key 门禁 15 条 + 真模型分数表 EVALS.md |
| B1 能力契约 ADR | 完成（Accepted） | docs/design/recipe-capabilities.md：manifest 声明面 + CapabilityKind 闭集 + 协商算法 + 装配期校验；快照确认采用方案 B（新增 session/mount 事件） |
| B2 manifest + 协商纯函数 | 完成 | CapabilityKind/MountSnapshot 进 core/session；manifest 声明字段（可选，legacy 兼容）+ resolveCapabilities + validateManifest + verifyDeclarations + 三类类型化错误（19 条单测） |
| B3 能力协商接线 | 完成 | AgentHost.capabilities() + 只挂选中 offerings + 装配期声明校验 + session/mount 成为日志第一条（第 11 种事件）+ 真实 JSONL 端到端验证 |
| B4 recipe 迁移与能力归属 | 完成 | manifest 声明必填、legacy 路径删除；fs/subprocess 迁入 Host（workspaceDir 为环境事实）；approval 成为 offering；三个 recipe 声明式化（179 测试） |
| B 阶段收尾验证 | 完成 | 真模型 add-bug PASS 10.6s + 机械核对（recipe 无 provider 构造、loop 无能力词汇依赖、提交未碰内核文件） |
| C1 沙箱/凭据 ADR | 完成（Accepted） | docs/design/sandbox-seam.md：威胁模型 + sandbox/credentials 能力形状 + Docker provider 契约 + 预算与并发边界 + 拒绝测试清单 |
| C2 sandbox seam + 本地 provider | 完成 | 新包 @cubus/sandbox（features 闭集 + UnconfinedSandbox）；本地 Host 声明 sandbox 能力；recipe 把 sandbox 声明为可选并记录进快照；CLI 运行前打印无隔离警告；SDK 暴露 mountSnapshot |
| D2 Eval Suite 制品化 | 完成 | fixtures/suites/repair-eval-v1.json 显式任务清单（含门禁档位）；loadSuite/validateSuite/resolveSuiteTasks；harness 入口校验 recipe 声明的套件已注册；评测结果写 EVALS.md + evals-latest.json（机器可读） |
| D1 评测/恢复 ADR | 完成（Accepted） | docs/design/eval-suite-and-resume.md：Eval Suite 一等制品 + 行为指纹与回归门禁 + 恢复与结算规则表 + sidecar 格式版本 + usage 字段 |
| C6 有界并发与队列 | 完成 | SDK 新增 ConcurrencyGate：跨会话并发上限（默认 4）+ FIFO 排队 + 等待超时（0 = 不排队）+ abort 出队；名额交接不经过空闲窗口；runtime.concurrency() 暴露名额与排队位置 |
| C5 预算策略 | 完成 | 新包 @cubus/budget：观察日志事件计数、超限调用 loop.cancel()、不新增事件；manifest.budget 默认 + app 逐字段覆盖，生效值进装配快照；CLI 新增 --max-steps/--max-tool-calls/--max-duration 并打印用量 |
| C4 Docker sandbox host | 完成 | 新包 @cubus/host-docker：会话级容器（--network none / 非 root / cap-drop ALL / no-new-privileges / 只读 rootfs + tmpfs / 内存·CPU·PID 上限 / 只挂工作区 / 无 docker.sock）；容器化 fs（docker cp）与 subprocess（docker exec）；镜像 pin digest 且 digest 进快照；Docker 不可用时集成测试显式 skip |
| C3 credentials seam + 环境白名单 | 完成 | 新包 @cubus/credentials（引用 + 租约 + 白名单发放）；LocalSubprocess 由名字黑名单改为最小环境白名单；Host 声明 credentials 能力（只有名字进快照）；CLI 经租约取模型凭据；DeepSeekAdapter 改用 ES 私有字段（JSON.stringify 不再带出 apiKey） |
| P4 Coding Agent profile | 完成（A 阶段收尾） | 下一步 D3：恢复与结算（sidecar 格式版本 + settled 闭合 + 孤儿工具结果） |
| P5 共享安全层 | 未开始 | Docker 沙箱 provider + 陌生仓库/无人值守边界，供所有 profile 复用 |
| P6 Agent 工作台 | 未开始 | Web UI + 多 profile + 会话/任务/工具/审批/差异视图 |
| P7 个人交付 | 未开始 | 单机安装 + 重启恢复 + 有界并发 + 备份/观测 + 可选 PR/通知 |

**测试现状**：231 个测试全绿（pnpm run check 一键验证：typecheck + lint + test）。34 个测试文件、20 个测试包、28 个包，分支 Cubus-v1.0。

**参考实现审计（2026-08-24）**：DeepSeek Harness 已同步到 `dsh-v0.1.1-rc.2`，pi 已同步到 `a470b121b`，Kthena 新增于 `f5b8fd7bc`；Cordis 与 Claude Code reference 无远端更新。Cordis vendor 仍与上游 `8cc9e33` 对齐。审计发现的 request/header、reasoning passback 和同会话并发缺口均已在 S2.3 关闭。各项目的详细借鉴笔记与边界见本地 `references/README.md`。

## 3. 五分钟接手地图（按顺序读）

1. AGENTS.md —— 工程纪律（宪法、检查、TS 风格、锁文件、vendoring），人和 agent 都遵守；
2. docs/handover.md —— 本文件；
3. packages/core/session/src/types.ts —— 宪法第一页：会话日志词汇表（11 种事件 + 投影规则；session/mount 是装配快照，不进投影）；
4. packages/core/agent-loop/src/loop.ts —— 循环驱动（turn/step 语义，约 200 行，必读）；
5. packages/seams/llm/src/types.ts —— llm seam 的接口定义；
6. docs/design/coding-agent-product.md —— Coding Agent 用户、信任边界与阶段验收；
7. docs/design/recipe-capabilities.md —— B 阶段设计：recipe 声明面、能力协商、装配期校验（Accepted）；
7b. docs/design/sandbox-seam.md —— C 阶段设计：沙箱与凭据能力、Docker provider 契约、拒绝测试清单（Accepted）；
7c. docs/design/eval-suite-and-resume.md —— D 阶段设计：Eval Suite 契约、行为指纹门禁、恢复与结算、格式版本（Accepted）；
8. docs/design/tool-cancellation.md —— Tool signal、进程终止与事实日志结算；
9. packages/apps/cli/src/coding.ts —— 当前产品入口的校验、装配与结果输出；
10. docs/roadmap.md —— 四条产品声明对应的阶段计划与验收证据清单。

## 4. 架构一页图

```
底座层  @cubus/cordis       插件挂载、依赖注入、事件、作用域、可逆回卷
宪法层  @cubus/session      SessionLog seam + 10 事件词汇表 + 消息/请求投影纯函数
机制层  @cubus/agent-loop   通用 turn/step 循环、inbox、模型/工具取消、确定性回放
装配层  @cubus/agent-recipe typed Host/Recipe 契约 + 单会话 Cordis 组合根
接缝层  @cubus/llm          LlmAdapter 接口 + Scripted（假）+ DeepSeek（真）
供应层  @cubus/session-jsonl append-only JSONL 持久化 + 末行截断恢复 + 落盘后实时订阅 + Cordis provider
宿主层  @cubus/host-local   每会话独立模型实例 + 本地 JSONL 环境装配
策略层  @cubus/tool-approval Host 提供审批 policy；工具 wrapper 紧贴副作用执行
        @cubus/llm-retry    adapter wrapper；只重试尚未产出 chunk 的 typed 暂态错误
能力层  @cubus/tools        可取消的 fs/subprocess + read/edit/write/bash（编码 profile 的候选能力）
检查层  @cubus/git         只读工作区版本状态 seam；@cubus/git-cli 经 subprocess seam 实现
产品层  @cubus/recipe-*     reference / coding / repair-eval；只选择 prompt、tools 与领域插件
门面层  @cubus/sdk          JSON-RPC 2.0 + typed Host/Recipe 会话运行时 + session.cancel + session.subscribe
应用层  @cubus/cli          参数/信任校验 + 产品装配 + Ctrl-C 结算 + headless 输出
验证层  @cubus/evals        修复任务 harness；验证通用内核，不定义内核用途
```

三条宪法铁律（改它们 = 改架构，必须讨论）：

1. 会话日志是唯一事实源；模型可见 = 已记录（任何进模型请求的内容都能从日志重建）；
2. 工具只摸 fs/subprocess seam，不直接碰磁盘（沙箱后置的抵押品）；
3. 新行为挂扩展点；改循环驱动本身要先讨论。

## 5. 仓库布局与常用命令

```
vendor/cordis/                    冻结的 cordis 快照（改动必须记账 vendor/README.md）
packages/core/session/            会话事实源契约、事件词汇表与投影
packages/core/agent-loop/         循环 + cordis 插件
packages/core/system-prompt/      可排序、可卸载的 prompt contribution service
packages/core/tool-registry/      Tool 契约 + 作用域注册 + 确定性 step 快照
packages/core/agent-recipe/       typed Host/Recipe 契约与可回卷组合根
packages/providers/session-jsonl/ JSONL 会话存储 provider
packages/hosts/local/             本地单进程 Host（每会话 LLM + JSONL）
packages/policies/tool-approval/  provider-neutral 工具审批 seam + Host/Tool 装饰器
packages/policies/llm-retry/      provider-neutral 模型有界重试 wrapper
packages/recipes/reference-agent/ 领域无关参考 Agent（add_numbers，无 fs/shell/repo）
packages/recipes/coding-agent/   正式 Coding Agent Recipe（受信工作区 + 四工具）
packages/recipes/repair-eval/     由 Coding Recipe 工厂派生的修复评测变体
packages/apps/cli/                Coding Agent headless CLI 应用入口（含运行前后只读 Git 变更报告）
packages/seams/llm/               模型接缝（接口 + 两个 provider）
packages/seams/git/               只读 Git 工作区状态 seam（Service Definition）
packages/evals/evals/             修复任务评测：fixtures/bug-repos/* 自描述夹具 + 无 key 门禁 + 真模型分数表
packages/providers/git-cli/       git CLI 只读 provider（走 subprocess seam）
packages/plugins/tools/           真工具（fs/subprocess seam + 四工具）
packages/sdk/sdk/                 SDK（协议/传输/服务端/会话运行时）
packages/evals/evals/             评测（harness + fixtures + 真模型入口）
packages/support/*                工具链与 cordis 冒烟测试
docs/                             文档（本文件）
AGENTS.md                         工程纪律
.env                              DeepSeek key（git 忽略；仓库根；格式 DEEPSEEK_API_KEY=sk-...）
```

```bash
pnpm install --frozen-lockfile   # 依赖（CI 同款）
pnpm run check                   # typecheck + lint + test，一步验证全绿
pnpm run test                    # 只跑测试
pnpm run cubus -- --help         # Coding Agent CLI 帮助
pnpm run cubus -- coding --workspace /path/to/repo --task "修复测试" --trust-workspace --approval ask --max-model-attempts 3
pnpm --filter @cubus/sdk run demo        # 真实进程 stdio 演示（假模型）
pnpm run eval:real               # 真模型修 bug 评测（需要 .env 里的 key，花真钱）
```

## 6. 关键设计决策与理由

| 决策 | 理由 |
|---|---|
| vendor cordis 而非手写/安装 | 底座约 1800 行含异步回卷等易错逻辑；上游 API 未稳定，vendor + 台账防漂移。DSH 同款做法 |
| 假模型 + 真模型双层评测 | 假模型（ScriptedAdapter）保证确定性回放、CI 无 key 全绿；真模型（eval:real）暴露集成缺口（已三次立功） |
| 会话日志是唯一事实源 | UI/resume/回放/遥测全部是日志的读法；确定性是对抗 agent 非确定性的武器 |
| 沙箱后置到 P5 | seam 第一天就位，换 provider 零改动；P5 前只跑内部仓库（容器里跑服务作粗隔离） |
| 契约与实现分离 | Loop 类从朴素注入到 cordis 插件经历三种挂法零逻辑改动——内核冻得住 |
| adapter 工厂注入 | 会话间不共享有状态 provider（假模型的场景队列、将来的每会话限流） |
| 评测 fixture 不可变 | 任务永远跑在 fixture 的临时副本上；原样仓库永远带 bug（被真模型改坏过一次，教训入章） |
| 模型子进程清洗宿主凭据 | `bash` 保留 PATH 等普通环境，但不继承名称含 KEY/SECRET/TOKEN/PASSWORD 的变量，防止模型通过 `env` 或命令输出拿到 harness 凭据 |
| SDK 按会话串行化 run | 每个 `session.run` 拥有一个完整 turn 区间；同会话排队、不同会话仍可并行，避免把 Loop 的 fire-and-queue 语义误当成单条完成通知 |
| request/header 先记录后调用 | 每个 step 在调用模型前记录 provider/model/system prompt/工具 schema，再由该 header 之前的日志前缀重建实际请求；未来事件不会污染历史请求 |
| reasoning 收束并回传 | chunk 保留流式回放，assistant/message 保存完整 thinking；DeepSeek 后续请求对所有含 reasoning 的 assistant 轮次回传 `reasoning_content` |
| 通用内核与产品 profile 分离 | loop/session/llm 只定义 Agent 机制；Coding Agent 的提示词、工具和评测属于一种组合，不反向定义内核 |
| all is plugin 是产品化方法 | 不靠复制或 fork 内核产生新 Agent；通过 profile/bundle 选择插件并形成可复现的产品装配 |
| step 能力先快照再请求 | 每个 step 只解析一次 prompt/tools；先冻结并记录 request/header，再用同一工具快照执行调用，避免模型 schema 与执行器漂移 |
| Prompt contribution 确定性组装 | fragment 以稳定 id 标识，按 order + id 排序；重复 id 在请求前失败，注册随 Cordis fiber 撤销 |
| Tool 契约不属于 Loop | `Tool` 由独立 registry 包定义；Loop 只消费 step 快照，具体 read/edit/bash 等工具不再反向依赖 agent-loop |
| step 内能力不可漂移 | 插件即使在模型流中途卸载，已经发出的工具调用仍使用该 step 的原快照完成；下一 step 才观察到新注册表 |
| 会话契约与持久化分离 | `@cubus/session` 只定义事件、投影和 `SessionLog` seam；JSONL 路径、文件 IO、截断恢复与损坏检测属于 Host 提供的 `@cubus/session-jsonl` |
| Loop 不创建环境资源 | agent-loop 插件同时注入 `llm` 与 `sessionLog`；provider 替换会触发 Cordis 重挂，Loop 始终消费当前 Host 环境而不拥有文件系统策略 |
| Host 与 Recipe 是正交轴 | Host 只挂模型、日志等环境 provider；Recipe 只挂 prompt/tool/领域插件。组合根固定按 capability services -> Host -> Recipe -> Loop 装配 |
| 一会话一棵组合树 | `SessionRuntime` 绑定一个 typed Recipe；每次 `session.create` 创建独立 Context、Host provider 和 Recipe contributions，整棵树由一个父 fiber 可逆回卷 |
| SDK 只做协议与会话编排 | SDK 不再依赖 agent-loop、LLM 实现、JSONL provider 或具体 Tool；它只消费 `AgentHost` / `AgentRecipe` 并保持 JSON-RPC 方法不变 |
| reference-agent 是原型证据 | 默认参考产品只有领域无关 prompt 与 `add_numbers`，不依赖文件系统、Shell 或代码仓库；CubusAgent 因此不再靠 coding eval 证明自己“通用” |
| repair-eval 是产品变体而非内核身份 | 通用 coding 工具组合由正式 Coding Recipe 工厂拥有；repair-eval 只替换 manifest 与评测 prompt，同一 SDK/Host/Loop 下事件骨架不变 |
| CLI 是应用入口，不是 Agent 插件 | CLI 只解析参数、校验信任、选择 Host/Recipe 并展示结果；Coding 行为在 Recipe，模型与日志在 Host，Loop 仍保持通用 |
| trust 是知情确认而非沙箱 | S4.1 必须显式 `--trust-workspace` 才会读取凭据或创建工具，但本地 bash 仍继承宿主权限；陌生仓库与无人值守执行留给 Docker provider |
| 会话日志不放工具工作区 | CLI 默认写入 `~/.cubus/sessions`，并拒绝把 sessions 目录放在文件工具可写的 workspace 内，避免产品装配主动暴露唯一事实源 |
| repair-eval 复用正式产品装配 | `repair-eval` 由 `createCodingAgentRecipe()` 派生，只替换 manifest 与评测 prompt；正式产品和评测不复制工具组合，更不复制 Loop |
| 审批紧贴工具而非进入 Loop | Host 提供 `ToolApprovalService`，Coding Recipe 统一包装工具执行器；缺 provider 时挂载失败，不允许静默退回 allow-all |
| ask 的保守默认 | CLI 默认为 ask；TTY 中逐次确认，非交互环境默认 deny。`--approval allow` 必须显式选择，repair eval 也明确声明自动评测 allow |
| 最小审批审计不扩词汇 | `tool/call` 先记录；deny 成为 `tool/result ok:false`；allow 后才执行。当前不记录审批人/规则版本，若需要 provenance 必须单独讨论新事件和迁移 |
| Provider 归一化模型错误 | `LlmError` 携带 kind/retryable/status；DeepSeek 负责解释 HTTP、网络和协议事实，retry policy 不解析供应商错误字符串 |
| 重试只包 adapter | `@cubus/llm-retry` 以 wrapper 提供有界指数退避和 abort-aware 等待；Loop 不增加供应商条件分支，CLI 与真模型评测显式装配 |
| 产出 chunk 后禁止重试 | 同一 step 尚未产出 chunk 时可重发已记录的同一请求；一旦日志已有正文、思考或工具意图，自动重试会造成重复内容或副作用意图，必须原样失败 |
| Tool 执行上下文只放运行态 | `Tool.execute(args, { signal })` 让取消贯穿所有能力；审批/沙箱/预算不塞进上下文，继续由独立 policy/provider 负责 |
| 取消也必须完整结算 | 已记录的每个 `tool/call` 都写对应结果；当前调用记 `cancelled`，后续调用记 `cancelled before execution`，随后关闭 step/turn 且不再请求模型 |
| 子进程按进程组终止 | Unix Shell 使用独立进程组；取消先 SIGTERM 再 SIGKILL，超时也杀整组。Windows 直接子进程限制与真正隔离留给 Docker provider |
| 取消入口属于应用/门面 | SDK 暴露 `session.cancel`，CLI 将首次 Ctrl-C 转为协作式取消并以 130 退出；Loop 只认识 AbortSignal，不认识终端或 RPC |
| Git 报告只读且与取消解耦 | 基线在运行前记录、报告在结束或取消后必须产出，因此报告不接收运行期 AbortSignal；否则取消会让报告直接抛错 |
| 变更分类按基线哈希，行数按 HEAD | 哪些文件被动过由基线内容哈希判定（保留用户既有改动边界）；行数只能相对 HEAD（不修改仓库就取不到基线内容快照），该限制写在 seam 类型文档里 |
| Git 摘要由 provider 拥有 | CLI 只逐行输出 provider 的 `summary`；格式与排序在 provider 内确定性生成，避免各入口各写一套 Git 语义 |
| 实时流是日志的视图而非第二状态源 | `SessionLog` 增加可选 `subscribe`；provider 只在事件落盘后回调，回调参数与日志事件完全相同（「流上看到」蕴含「日志里已记录」），Loop 一行未改 |
| 订阅者异常不影响落盘 | 广播时逐订阅者捕获异常：事件已持久化，回调失败不能看起来像落盘失败，也不能阻断其它订阅者 |
| 实时渲染只做呈现、不持有状态 | CLI renderer 消费事件并成行输出：chunk 缓冲遇换行成行，工具调用/结果即时成行；思考增量暂不渲染但完整留在日志 |
| 声明是数据、装配是代码 | manifest 只放名字与引用（能力 kind、prompt 片段 id、工具名、策略档名、评测 suite id）；分支/实现留在 mount。新增 manifest 字段必须同时给出装配期如何校验它 |
| 能力 kind 是闭集 | 表达新需求要么用已有 kind+features，要么先落一个 seam 实现；不在配置层发明能力 |
| 协商歧义即失败 | 同 kind 多个候选且 app 未 pin -> 装配期报错；不静默挑一个，也不在运行期降级 |
| 装配快照是独立事件 | 新增 session/mount（第 11 种）：唯一且最先、非模型可见、确定性、可序列化无凭据；装配失败不写日志，所以它的存在等价于装配成功 |
| 只挂被选中的能力 | Host 声明供给清单，运行时只把协商选中的 offerings 挂进会话；未选中的 mount 不被调用（有测试断言） |
| 环境能力归 Host，产品面归 Recipe | B4 起 Recipe 不接收任何 provider：fs/subprocess/workspaceDir 由 Host 提供，Recipe 只声明 requires 并在 mount 时读取；三个 recipe 的 recipeOptions 都是 undefined |
| 装饰器只转发自己拥有的 offerings | withToolApprovalHost 把 approval 追加进 capabilities()，但转发给内层 Host 前必须过滤掉不属于它的项；否则同一服务被注册两次（踩过一次） |
| git 报告保持 app 级只读探测 | 基线必须在会话创建前拍，而 Host 能力只在会话 ctx 里；工作区路径本就是 app 的部署输入，所以报告不进能力协商（容器化后见 D1） |
| 无隔离必须是显式特性 | 本地 sandbox provider 只声明 unconfined；需要 fs-isolation 的 recipe 在本地 Host 上装配期失败，不静默降级 |
| 沙箱与 fs/subprocess 叠加而非替换 | sandbox 描述强制边界，fs/subprocess 描述边界内怎么读写与执行；三者在同一 Host 内必须自洽 |
| 并发上限在 Runtime 层 | 会话内串行早有（S2.3a runTail），C6 加的是跨会话上限；排队发生在「轮到本会话」之后，因此不会占着名额空等 |
| 队列状态经 SDK 暴露、不由 CLI 打印 | 单进程单次运行的 CLI 不可能排队（它自己就是唯一调用者）；runtime.concurrency() 面向 P6 的多会话服务端 |
| 预算不进 Loop | 预算 = 观察会话日志的策略插件，超限调用 loop.cancel() 走既有取消与结算；不新增事件类型，trip 原因经 budget 服务暴露给 app |
| 恢复是继续、不是回滚（Draft） | 已记录的副作用绝不重放；崩溃留下的半成品不回滚；未闭合区间用结算事件补齐（孤儿工具调用必须补结果，否则协议配对失败） |
| 门禁只比行为投影（Draft） | golden 不含文本、参数、行数与时间戳；只比判分、事件类型序列、工具序列与工作区文件集 |
| 预算是逐字段合并 | manifest.budget 提供产品默认（coding 系 40 步 / 60 次工具 / 10 分钟），app 只覆盖它关心的字段；合并后的生效值进快照 |
| sandbox 是可选但必须记录的需求 | 三个 recipe 都声明 { kind: sandbox, required: false }：不强制隔离档，但 Host 的隔离事实（含 unconfined）一定进装配快照 |
| 隔离状态在运行前就告知 | CLI 从装配快照读 sandbox 能力并打印：local-unconfined - NO ISOLATION；docker host 则打印 features 清单 |
| 凭据是引用而非明文 | 明文只在 Host 内部，注入发生在执行边界；明文永不进日志、快照与工具结果（拒绝测试断言） |
| 审批不等于沙箱 | 审批是人（可被说服、会疲劳），沙箱是机器强制；两者都要有，但不可互相替代 |

## 7. Reference 项目的借鉴边界

Reference 是设计证据和失败案例，不是待合并的上游。我们吸收它们解决问题的理念，用 CubusAgent 自己的宪法、接口和行为测试重新实现；项目规模、部署条件或事实源模型冲突时，以 CubusAgent 为准。

| 项目 | 在 reference 集合中的角色 | 重点学习 | 明确边界 | 主要落点 |
|---|---|---|---|---|
| DeepSeek Harness | 架构母本与最高优先级对照 | append-only 会话事实源；模型可见即已记录；持久/实时/能力事件分域；definition-provider-consumer seam；profile/bundle 组合；可执行不变量；审批默认拒绝 | 不照搬事件词汇、包数量和完整产品面；不把 reference 当可直接合并的上游 | P3 完成通用插件装配；P4 审批 seam；P5 沙箱；P6 工作台只是一个 profile 宿主 |
| pi | 小内核、provider 与工具工程对照 | provider 边界归一化；保留原始历史的 compaction；intent-effect-settlement 恢复模型；按规范路径串行化文件修改；可取消且有上限的重试；供应链加固 | pi 默认继承宿主权限，不是安全边界；其 mutable registers 不能替代我们的 append-only 唯一事实源；不追逐完整 provider/TUI 矩阵 | S4.3 已落地错误分类、重试和工具取消；P3 后评估压缩；P7 参考恢复和交付加固 |
| Cordis | 已 vendored 的组合与生命周期底座 | effect 必须可回卷；事件 dispatch mode 是契约；服务 realm 隔离；依赖注入；通过挂载/卸载获得可选能力 | 不承担会话真相、权限和 agent 语义；上游 API 不稳定；Cordis 机制不泄漏成产品 API | 新行为优先挂既有事件/seam/工具注册；升级必须按 vendor 台账审计 |
| Claude Code archive | 生产级工具安全与 UX 案例库 | 每次工具调用的权限决策；shell 分层防御；diff/进度/工具卡片；resume/compact/cost/doctor；重功能延迟加载 | 非官方 source-map 暴露快照，绝不 vendor 或复制实现；不引入其企业策略、分析、远程控制和庞大功能面 | P4 Coding Agent 交互；P5 权限 UX；P6 工作台；P7 doctor/恢复体验 |
| Kthena | 控制/执行分离的远期系统对照 | desired state 与 execution 分离；filter-score-select 策略框架；独立可部署组件；provider 边界；有界队列、指标与稳定窗口 | 不引入 K8s、CRD、Operator、Helm、Redis、多租户、GPU 调度和推理扩缩容 | P6/P7 任务管理的设计输入；出现真实恢复/调度需求后才考虑轻量 reconciler |

跨项目只保留五条共同原则：

1. **先守事实源，再加能力**：任何恢复、UI、压缩、审批和调度设计都不能绕过会话日志，也不能破坏“模型可见即已记录”。
2. **策略挂扩展点，机制保持小**：重试、预算、审批、沙箱、provider 选择和 job 调度属于 seam/plugin/policy，不向 Loop 堆条件分支。
3. **安全边界必须真实存在**：提示词、命令分类和警告只提供纵深防御；真正隔离依赖进程外 Docker 沙箱、凭据最小暴露和默认拒绝审批。
4. **耐久性围绕不确定副作用设计**：先记录意图，再执行外部作用，再记录结果；恢复必须区分可安全重放和不可重放操作。
5. **内核通用，产品具体，部署克制**：内核不知道“coding”或“workbench”；profile 明确用户和能力；官方工作台默认单用户、单机、自带凭据，实际负载出现前不建设 K8s 或多租户平台。

## 8. 踩过的坑（务必遵守的教训）

1. 锁文件纪律：任何 package.json 变化后 pnpm-lock.yaml 必须一起提交；CI 的 frozen-lockfile 会拦（已拦过两次）。
2. pnpm 11 安装脚本白名单：新依赖带安装脚本要 allowBuilds 批准（esbuild 已有条目）。
3. TS 风格：禁止构造器参数属性（踩 4 次）、enum/namespace；exactOptionalPropertyTypes 下可选字段用条件展开。
4. 提交前 git status --short 逐行核对（S1.3a 事故：源码漏提交、锁文件提交了，CI 才暴露）。
5. node --test 要用 glob：node --test 'test/*.test.ts'；node --test test/ 在 Node 23 会把路径当模块报 ENOENT。
6. spawn 必须处理 'error' 事件，且错误信息带 cwd——cwd 不存在时报的是误导性的 spawn /bin/sh ENOENT。
7. fixtures 目录要 exclude 出 vitest；fixture 内的测试文件会被默认扫描误当套件。
8. 跨包 import 必须在 package.json 声明依赖（TS 的 cannot find module 常是缺依赖声明）。
9. .env 在仓库根；程序从脚本位置自定位根目录（不依赖 cwd）；key 永不进聊天记录、永不进 git。
10. 检查命令看退出码，不要用管道吞掉结果（本地绿不等于云端绿，最终以 CI 为准）。
11. 测试等待用 id 关联轮询（等到匹配该 id 的响应），不要固定 setTimeout 猜延迟再读"最后一条"——慢机器（CI）上会竞态读到上一条响应。
12. 模型发起的命令不能继承宿主凭据；`DEEPSEEK_API_KEY` 一旦进入 bash 环境，模型可通过 `env` 或输出文件直接外泄。
13. `Loop.submit()` 在已有 turn 运行时只负责入队，不代表该条输入已完成；需要逐调用结果的协议层必须自己拥有并串行化运行区间。
14. pnpm 在非 TTY 环境重建 `node_modules` 会拒绝确认；需要同步锁文件时用 `CI=true pnpm install --no-frozen-lockfile`，随后必须用 frozen-lockfile 复验。
15. 不要并行启动多个可能触发 pnpm 依赖状态自检的命令；`node_modules` 需要重建时会争抢清理。安装完成后再串行跑定向检查。
16. pnpm 的 `run ... -- args` 会把分隔符保留进嵌套脚本 argv；每个入口脚本都要归一化一个前导 `--`（CLI 入口踩过一次，2026-10-09 评测脚本又踩一次），并用真实子进程测试退出码和 stdout/stderr。
17. macOS 的临时目录 `/var/...` 经 `realpath` 会变成 `/private/var/...`；涉及安全边界和路径归属的实现与断言都比较规范路径。
18. 模型流一旦产出任何 chunk 就不能透明重试；此时 request/header 与模型输出前缀已进入事实日志，重发会制造重复正文或工具意图。
19. 只调用 `child.kill()` 通常只杀 Shell，不会收束它启动的后台进程；Unix 本地 provider 必须使用独立进程组，并测试忽略 SIGTERM 的孙进程不会继续产生副作用。
20. 取消不等于回滚：已完成的工具结果必须保持真实；文件工具只能在副作用前检查 signal，事务语义需要独立 provider 支持。
21. 本地 `pnpm run check` 通过不等于阶段已锁定；每个小步必须提交、push，并等待该 commit 的 GitHub Actions 全绿后才能进入下一步。S2.3-P4 曾长期堆在本地，现已把此顺序写入 `AGENTS.md`。
22. 给别处模块做 declaration merging 时，本文件必须显式 import 被增强的模块（副作用导入即可）；否则 TypeScript 把它当成新的模块声明，破坏其它包已有的 Context 合并 —— 表现为别处的 ctx.provide 突然「不存在」。（B4 踩过一次）
23. Host 装饰器在协商路径下必须只转发自己拥有的 offerings：把不属于自己的项一起传给内层 Host，会让同一服务（ctx.provide 同名键）注册两次并在装配期抛错。（B4 被测试抓到）
24. 子进程环境必须用白名单，不能用名字黑名单：黑名单（KEY|SECRET|TOKEN|PASSWORD）会被「换个名字」绕过 —— 真实实验里 HARMLESS_CREDENTIAL 原样传给了子进程。白名单 + 显式凭据注入才是边界。（C3 修复）
25. TS 的 private 只是编译期标注，运行期仍是可枚举属性：持有 apiKey 的字段若用 private，JSON.stringify(adapter) 会带出明文。持密字段要用 ES 私有字段（#field）。（C3 修复）

## 9. 已知问题 / 技术债（接手后可以处理）

- run.ts 真模型评测：已有最多 3 次模型尝试，但无总预算/工具步数上限（跑飞了只能手动 Ctrl-C）；失败后需人工读日志。
- 组合：Host/Recipe 已成为 typed 装配入口，但尚无 Recipe 身份的持久化与 resume；按 ADR 留到 session resume 设计，不在 P3 修改事件词汇。
- Coding Agent CLI：已有一次性任务、Ctrl-C 取消、日志结算、只读 Git 变更报告与实时事件渲染（chunk 逐行、工具卡片、结果行）；仍无交互式多轮、session resume、patch 级 diff；思考增量未进入实时视图；工具卡片样式仍在 CLI 内实现，未下放到 tool 定义。
- Git 报告：未跟踪文件行数依赖 /dev/null（Windows 待 P5）；行数不区分用户既有改动与 agent 改动（用 changed/preexisting 分类字段区分）；重命名会按新旧路径各记一条，无 rename 语义。
- 本地（local-unconfined）仍无文件边界：那是设计上的诚实档位，要边界就用 Docker Host（C4 已完成）。
- Docker Host 目前只能被 embedding/测试使用：CLI 还没有 --sandbox docker 入口（属 P6/P7 交付面），因此产品默认仍是本地档。
- 会话/容器数量上限尚未限制：C6 限制的是并发运行数，同时存在的会话（= Docker 容器）数量属 app 级策略，留给 P6 多会话服务一起设计。
- 容器取消只杀 docker exec 进程组：容器内孤儿进程会活到会话销毁；要更强语义需在容器内做进程组管理（C4b 候选）。
- 默认镜像 digest 是常量（node@sha256:c3de60…）：升级基础镜像要手动改常量并跑一遍集成测试。
- 容器网络只有 none（C1 决定 2）：需要装依赖的仓库目前只能在工作区外先装好。
- 装配快照记录 recipe 身份/能力/策略档，但工作区路径不在其中（它是 Host 的环境事实，不是 recipe 配置）；要追溯「哪次评测跑了哪个目录」目前靠 EVALS.md 与临时目录名，等 D1 的格式版本一起加环境字段。
- manifest 的 evaluation 声明已由 harness 校验套件真实注册（D2 关闭）；运行时仍不做跨包套件检查（内核不依赖评测包，属有意设计）。
- 恢复与结算（D3）尚未实现：崩溃留下的未闭合区间与孤儿工具调用目前只能人工读日志（D1 已给出规则表）。
- 评测：真模型分数表记录通过率与耗时，但不记录 token/费用（adapter 与日志都还没有 usage 字段）——要报成本先补 usage 落日志。
- 评测：真模型全量跑目前是手动命令（pnpm run eval:real）；做成夜跑 CI 需要把 DEEPSEEK_API_KEY 作为仓库 secret，属于凭据决策，未擅自添加。
- LLM provider：DeepSeek 已有 typed 错误和有界重试；其他供应商尚未接入，thinking 字段归一化表（vLLM/Qwen 等）未做。
- 会话日志：无 SQLite/索引，查询靠全量读；无 SESSION_FORMAT_VERSION 信封。
- 评测集：已有 7 个 fixture（7 类 bug）+ 自描述 fixture.json + 无 key 门禁；仍需攒到 30-50 个，并补 golden trajectory 回归门禁（roadmap D4）与真实仓库级任务（多文件、依赖安装）。
- 循环：模型与工具执行均可取消且能闭合日志；但已完成的文件副作用不回滚，模型重试耗尽或产出部分 chunk 后失败仍会留下未闭合 step；无自动 resume/settlement 和压缩。
- subprocess：Unix 本地 provider 能终止进程组；Windows 首版只能终止直接子进程，可靠的跨平台进程树隔离留给 P5 Docker provider。
- 权限：ask/allow/deny 已覆盖 Coding 工具执行，但审批不限制被允许命令的系统权限；真正的文件/网络/进程隔离仍是 P5 Docker provider。
- 工作台：不存在（P6）；不能在 profile 体系完成前让 Web 入口反向定义内核。

## 10. 下一步：D3 恢复与结算（roadmap D3）

D2 让评测成为显式制品；D3 让崩溃后的会话能继续（D1 §5 的规则表）：

1. sidecar 格式版本：运行时在装配前写 session.meta.json（formatVersion 2），读取方缺失按 v1、过高版本拒绝；
2. 结算：未闭合 turn/step 补闭合事件（turn/end 带 settled: true），孤儿 tool/call 补结果未知的 tool/result；
3. 恢复入口：从日志重建投影 + 校验装配身份一致（不一致即拒绝），之后正常 run；
4. 词汇变更随本步落地：turn/end 的 settled? 与 assistant/message 的 usage?（D1 决定 1、4）；
5. 验收：kill -9 跑到一半的会话再恢复，下一轮请求投影里每个 tool_call 都有配对；装配不一致时明确拒绝。

D4 在这之后：评测集扩到 30–50 个任务 + 行为指纹回归门禁。

## 11. 对下一个接手者（人或 agent）的三句话

1. 先跑 pnpm install --frozen-lockfile 和 pnpm run check，必须全绿才能动手；
2. 改任何东西前先读对应包的测试——测试就是规格书；
3. 不确定时先问"这是通用 Agent 机制，还是某个产品 profile 的能力；它挂哪个扩展点"，而不是"在哪里加代码"。
