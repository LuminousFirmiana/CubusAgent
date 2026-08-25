# CubusAgent 交接文档

> 最后更新：S4.3b 工具执行取消完成。本文件是"接手这个项目的第一份读物"。

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
| P4 Coding Agent profile | 进行中 | 下一步 S4.4 Git 变更报告；其后实时输出与更多 fixtures |
| P5 共享安全层 | 未开始 | Docker 沙箱 provider + 陌生仓库/无人值守边界，供所有 profile 复用 |
| P6 Agent 工作台 | 未开始 | Web UI + 多 profile + 会话/任务/工具/审批/差异视图 |
| P7 个人交付 | 未开始 | 单机安装 + 重启恢复 + 有界并发 + 备份/观测 + 可选 PR/通知 |

**测试现状**：109 个测试全绿（pnpm run check 一键验证：typecheck + lint + test）。30 个测试文件、19 个测试包，分支 Cubus-v1.0。

**参考实现审计（2026-08-24）**：DeepSeek Harness 已同步到 `dsh-v0.1.1-rc.2`，pi 已同步到 `a470b121b`，Kthena 新增于 `f5b8fd7bc`；Cordis 与 Claude Code reference 无远端更新。Cordis vendor 仍与上游 `8cc9e33` 对齐。审计发现的 request/header、reasoning passback 和同会话并发缺口均已在 S2.3 关闭。各项目的详细借鉴笔记与边界见本地 `references/README.md`。

## 3. 五分钟接手地图（按顺序读）

1. AGENTS.md —— 工程纪律（宪法、检查、TS 风格、锁文件、vendoring），人和 agent 都遵守；
2. docs/handover.md —— 本文件；
3. packages/core/session/src/types.ts —— 宪法第一页：会话日志词汇表（10 种事件 + 投影规则）；
4. packages/core/agent-loop/src/loop.ts —— 循环驱动（turn/step 语义，约 200 行，必读）；
5. packages/seams/llm/src/types.ts —— llm seam 的接口定义；
6. docs/design/coding-agent-product.md —— Coding Agent 用户、信任边界与阶段验收；
7. docs/design/tool-cancellation.md —— Tool signal、进程终止与事实日志结算；
8. packages/apps/cli/src/coding.ts —— 当前产品入口的校验、装配与结果输出。

## 4. 架构一页图

```
底座层  @cubus/cordis       插件挂载、依赖注入、事件、作用域、可逆回卷
宪法层  @cubus/session      SessionLog seam + 10 事件词汇表 + 消息/请求投影纯函数
机制层  @cubus/agent-loop   通用 turn/step 循环、inbox、模型/工具取消、确定性回放
装配层  @cubus/agent-recipe typed Host/Recipe 契约 + 单会话 Cordis 组合根
接缝层  @cubus/llm          LlmAdapter 接口 + Scripted（假）+ DeepSeek（真）
供应层  @cubus/session-jsonl append-only JSONL 持久化 + 末行截断恢复 + Cordis provider
宿主层  @cubus/host-local   每会话独立模型实例 + 本地 JSONL 环境装配
策略层  @cubus/tool-approval Host 提供审批 policy；工具 wrapper 紧贴副作用执行
        @cubus/llm-retry    adapter wrapper；只重试尚未产出 chunk 的 typed 暂态错误
能力层  @cubus/tools        可取消的 fs/subprocess + read/edit/write/bash（编码 profile 的候选能力）
产品层  @cubus/recipe-*     reference / coding / repair-eval；只选择 prompt、tools 与领域插件
门面层  @cubus/sdk          JSON-RPC 2.0 + typed Host/Recipe 会话运行时 + session.cancel
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
packages/apps/cli/                Coding Agent headless CLI 应用入口
packages/seams/llm/               模型接缝（接口 + 两个 provider）
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
16. pnpm 的 `run ... -- args` 会把分隔符保留进嵌套脚本 argv；CLI 入口要归一化一个前导 `--`，并用真实子进程测试退出码和 stdout/stderr。
17. macOS 的临时目录 `/var/...` 经 `realpath` 会变成 `/private/var/...`；涉及安全边界和路径归属的实现与断言都比较规范路径。
18. 模型流一旦产出任何 chunk 就不能透明重试；此时 request/header 与模型输出前缀已进入事实日志，重发会制造重复正文或工具意图。
19. 只调用 `child.kill()` 通常只杀 Shell，不会收束它启动的后台进程；Unix 本地 provider 必须使用独立进程组，并测试忽略 SIGTERM 的孙进程不会继续产生副作用。
20. 取消不等于回滚：已完成的工具结果必须保持真实；文件工具只能在副作用前检查 signal，事务语义需要独立 provider 支持。
21. 本地 `pnpm run check` 通过不等于阶段已锁定；每个小步必须提交、push，并等待该 commit 的 GitHub Actions 全绿后才能进入下一步。S2.3-P4 曾长期堆在本地，现已把此顺序写入 `AGENTS.md`。

## 9. 已知问题 / 技术债（接手后可以处理）

- run.ts 真模型评测：已有最多 3 次模型尝试，但无总预算/工具步数上限（跑飞了只能手动 Ctrl-C）；失败后需人工读日志。
- 组合：Host/Recipe 已成为 typed 装配入口，但尚无 Recipe 身份的持久化与 resume；按 ADR 留到 session resume 设计，不在 P3 修改事件词汇。
- Coding Agent CLI：已有一次性任务、Ctrl-C 取消和日志结算，但仍是运行结束后汇总输出；无实时 chunk/tool 渲染、交互式多轮、session resume 和 Git diff 展示。
- LLM provider：DeepSeek 已有 typed 错误和有界重试；其他供应商尚未接入，thinking 字段归一化表（vLLM/Qwen 等）未做。
- 会话日志：无 SQLite/索引，查询靠全量读；无 SESSION_FORMAT_VERSION 信封。
- fixture 只有一个（add-bug）；评测集需要攒到 30-50 个 + golden trajectory 回归机制。
- 循环：模型与工具执行均可取消且能闭合日志；但已完成的文件副作用不回滚，模型重试耗尽或产出部分 chunk 后失败仍会留下未闭合 step；无自动 resume/settlement 和压缩。
- subprocess：Unix 本地 provider 能终止进程组；Windows 首版只能终止直接子进程，可靠的跨平台进程树隔离留给 P5 Docker provider。
- 权限：ask/allow/deny 已覆盖 Coding 工具执行，但审批不限制被允许命令的系统权限；真正的文件/网络/进程隔离仍是 P5 Docker provider。
- 工作台：不存在（P6）；不能在 profile 体系完成前让 Web 入口反向定义内核。

## 10. 下一步：S4.4 Git 变更报告

Coding Agent 已能受控执行和取消，但运行结束后用户只能从工具摘要猜测改了哪些文件。下一锁提供只读、确定性的 Git 变更报告：

1. 启动前确认工作区是否为 Git 仓库并记录基线状态，不要求工作区必须干净；
2. 结束或取消后输出相对基线的文件状态与 diff 摘要，保留用户原有未提交改动的边界；
3. Git 检查走独立 provider/service，不让 CLI 拼接输出、不把 Git 语义写进通用 Loop；
4. 测试覆盖干净仓库、用户已有改动、Agent 新增/修改文件和非 Git 目录；本步不自动提交、回滚或生成 PR。

P3 毕业证据：更换 Recipe 能改变提示词和工具，但不修改 session、loop、Host 或 SDK 协议内核；卸载组合根无残留；两种 Recipe 均通过自己的行为测试与同协议切换验收。

## 11. 对下一个接手者（人或 agent）的三句话

1. 先跑 pnpm install --frozen-lockfile 和 pnpm run check，必须全绿才能动手；
2. 改任何东西前先读对应包的测试——测试就是规格书；
3. 不确定时先问"这是通用 Agent 机制，还是某个产品 profile 的能力；它挂哪个扩展点"，而不是"在哪里加代码"。
