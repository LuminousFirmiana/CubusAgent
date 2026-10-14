# CubusAgent 交接文档

> 最后更新：**S1 产品身份（CubusCodingAgent）** —— 从冻结版另起 `feat/coding-agent` 分支，产品有了自己的身份（id/版本/提示词）与验收路径。
> 本文件是"接手这个项目的第一份读物"；冻结结论见 §10，产品路线见 docs/design/coding-agent-product.md §8。

## 1. 这个项目是什么

**CubusAgent**：基于 Cordis 底座、吸收 DeepSeek Harness（DSH）理念构建的**通用 Agent 原型与产品化框架**。内核不预设“编码”角色；模型、提示词、工具、记忆、权限、沙箱、交互界面和任务驱动都应通过插件参与组合。

它没有唯一的“最终 Agent”，而是三层关系：

1. **通用 Agent 原型**：会话事实源 + agent loop + LLM seam + 插件生命周期，证明任意 Agent 都能在这套机制上运行；
2. **产品 profile**：用不同插件组合成 Coding Agent、研究 Agent、自动化 Agent 等具体产品，彼此不 fork 内核；
3. **Agent 工作台**：进一步产品化的宿主，负责选择/管理 profile、会话、任务、审批、可视化和恢复。官方工作台仍以个人单机、自托管、自带凭据为默认部署边界。

修 bug 的 Coding Agent 评测只是第一条高强度纵向验收链，用来证明内核真的能调用工具完成外部任务；它不是 CubusAgent 的产品定义。

当前阶段：**运行时地基已冻结（v1.0 = 通用原型 + 参考产品），现在在它之上开发编码 Agent 产品 CubusCodingAgent**。产品能力按 docs/design/coding-agent-product.md §8 逐步落地：MCP 延迟加载 → 上下文压缩 → 跨会话记忆 → Agent Skills → 权限规则与本地 OS 沙箱 → 多 Agent 协作。技术路线：自研内核 + vendored cordis 底座（B 路线，决策记录见第 6 节）。

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
| E1 事件流协议 ADR | 完成 | docs/design/workbench-protocol.md：SSE（非 WebSocket）的选型理由、端点与状态码契约、id + Last-Event-ID 的精确续传（两次读 + 缓冲）、控制帧易失性与“日志是唯一事实源”、v1 只监听回环且不做鉴权的边界 |
| E2 事件流服务端 | 完成 | 续传测试：事件帧 id 连续且从 0 起，带 Last-Event-ID 重连后收到 [resumeFrom+1 .. N-1]（不丢不重） |
| **S4.5 记忆提炼** | 完成 | ①核心（`@cubus/memory`）：`EXTRACT_SYSTEM_PROMPT`（只记"下次仍然成立"的事实）、`parseMemoryCandidates`（**先 JSON、失败退化成一行一条**，两条路径都过滤空条目与缺字段的条目）、`storeCandidates`（逐条写入、去重交给 store、**单条失败不影响其余**）、`extractMemories`（自己调模型的离线路径）。②**触发方式（与设计有一处偏差，已写进设计文档 §12）**：`--extract-memory` 时 CLI 在任务结束后**再走一个正常回合**（user 消息 = 维护指令），再解析那条回答并写入 —— 好处是那次 `request/header`/`assistant/message` **天然在会话日志里**，内核不需要认识"提炼"，也不需要新事件类型或格式版本；偏差是这个回合用的是产品提示词而不是 `EXTRACT_SYSTEM_PROMPT`（专用模板那条路径目前只有单测覆盖，尚未接进 app 流程）。③**实测**（真模型、空工作区、任务里含两条约定）：日志里 `turn/start` 2 次（任务回合 + 提炼回合）、`request/header`/`assistant/message` 各 4 条；提炼回答是干净的 JSON 数组，内容与模型在任务中自己用 `remember_memory` 记的**完全一致** → 全部判为重复，记忆文件没有多出条目 —— **去重纪律在真实流程里被验证**，不只是单测。④测试：新包 +7（共 23），全量 **458**。还没做：跨会话召回评测（S4.6）、工作台一键提炼、按会话结束自动触发。 |
| **S4.4 记忆工具** | 完成 | ①`recall_memory`：按 `id` 取正文或按 `query` 关键词检索（命中数 → 新的在前）；单次输出 ≤ 8000 字符；**找不到时告诉模型记忆里总共几条、最近有哪些 id**（而不是只说"没有"，让模型能换招）。②`remember_memory`：显式记一条长期事实，去重（重复返回原 id、不写盘）；**写入效果是改本机文件，而这次工具调用进日志** —— "模型能记住什么"本身可审计。③`withMemory` 现在**扩声明 + 挂载**两个工具（产品不用改一行）；工具面因此变成 7 个：bash / edit_file / read_file / read_session_log / recall_memory / remember_memory / write_file。④**行为验证**（真模型，工作区空目录）：记忆正文 161 字符、索引只显示前 120 字符，编号 `ZEBRA-42` **只出现在被裁掉的那段**里 —— 模型答出 `ZEBRA-42` 且日志里有 `recall_memory {"id":"m-2026-10-13-001"}`，证明它确实按需取回了正文；同一任务里 `remember_memory` 让记忆文件真的多了一条 `m-2026-10-14-001`。测试：新包 +7（共 16），全量 **451**。 |
| **S4.3 记忆存储 + 索引注入** | 完成 | ①新包 `@cubus/memory`：`MemoryStore`（本机 append-only JSONL）——`append`（id 形如 `m-<日期>-<序号>`，序号取当天最大值 +1；**规范化文本去重**，重复不写盘）、`list`（**坏行只计数不致命**）、`recent`、`search`（关键词命中数 → 新的在前；刻意不是 RAG）。②`renderMemoryIndex`：只渲染**索引**（默认最近 12 条、单行 120 字符裁剪、带 id 与标签），并写明"正文用 `recall_memory` 取回"；**没有条目时返回 undefined** → 提示词里不出现空标题。③`memoryPlugin` / `withMemory(recipe, { store })`：把 `memoryStore` 挂成服务（S4.4 的工具要用）+ 注册系统提示片段（order 300：角色 0 → 用户 100 → 项目 200 → 记忆 300）。**分工同指令层**：app 造 store（路径在本机、在工作区之外，`fs` 能力按设计拒绝越界），插件只渲染与提供服务。④接线：工作台新增配置键 `memoryPath`、CLI 新增 `--memory <path>`（都默认 `~/.cubus/memory/memory.jsonl`）；快照 `session/mount.config.memory` 记 `{path, entries, indexLimit}`。⑤**行为验证**（真模型，工作区是空目录 —— 事实只存在于记忆文件）：问"长期记忆里 order 默认超时是多少毫秒？"→ 答 **2500**；日志里核对到索引段原文与 `memory` 事实；文件里故意留的坏行只产生一句"有 1 行无法解析，已跳过"。测试：新包 9 条，全量 **444**。 |
| **S4.2 指令分层落地** | 完成 | ①新包 `@cubus/instructions`：`loadInstructionTiers`（app 注入 `readText`；项目层按 `AGENTS.md` → `CLAUDE.md` 首个命中；**缺失不是错误**；单层 8k / 合计 16k 上限，截断**显式标注**并保留原文 sha256）+ `renderInstructionTier`（项目层写明"优先于通用说明"）+ `withInstructions(recipe)`（把已解析的层注册成系统提示片段，order 用户 100 / 项目 200；没有层时彻底透明）。②**分工**：app 读文件（用户层在工作区外，`fs` 能力按设计拒绝越界路径），插件只渲染已解析的层 —— 快照里的文本就是模型看到的文本，没有二次读取的竞态；插件是纯的，测试不需要文件系统（注入假 `readText`）。③接线：CLI 与工作台都在启动时加载（用户层 `~/.cubus/instructions.md`），随 `recipeOptions.instructions` 进装配快照；装饰器顺序 = 指令层最外层（它需要读 app 传进来的那份 options），为此给 `withInstructions` 加了 `AgentRecipe<void>` 重载，两种链路都能直接串。④**行为验证**（真模型）：工作区 `AGENTS.md` 写"回答必须以 `[PROJ]` 开头、项目代号 CEDAR-9"，问"这个项目的代号是什么？"→ 模型答 **`[PROJ] CEDAR-9`**（格式与事实都遵守）。⑤**日志证据**：`session/mount.config.instructions` 里有全文 + path + chars + sha256 + truncated；`request/header` 里还记了每一步的 `systemPrompt` —— 指令层有两条独立审计路径。测试：新包 9 条，全量 **435**。 |
| **S4.1 记忆设计** | 完成（Draft，待评审） | docs/design/memory.md：①**指令三层**（角色=产品提示词 / 用户=`~/.cubus/instructions.md` / 项目=工作区根 `AGENTS.md`，兼容 `CLAUDE.md`），顺序即优先级、后面的赢，每层默认 8k 字符上限、截断时**显式标注**；注入走既有系统提示片段（order 0/100/200），**不新增 seam、不改循环**。②**指令全文必须进日志**（不是只记路径+哈希）：`AGENTS.md` 是可变外部输入，只记哈希则"当时给模型看了什么"重建不出来；全文（含 path/chars/sha256/truncated）写进 `session/mount.config.instructions` —— 加法式，不加事件类型、**不动格式版本**。③**记忆存储 = 本机 append-only JSONL**（`~/.cubus/memory/memory.jsonl`）：`{id, at, tags, text, source:{sessionId,turnId}}`，id 形如 `m-<日期>-<序号>` 人可读、source 可追溯，**文件是唯一真相**（用户能直接编辑）。④**只注入索引**（默认最近 12 条，一行一条），细节用 `recall_memory` 按 id/关键词取回 —— 与 MCP"名字便宜、正文贵"同一结论。⑤**读用工具、写用"提炼回合"**（`remember_memory` + 会话后台提炼），两条路径都进日志、都去重、失败都不阻断任务。⑥**不新增能力 kind**：记忆用的是既有 `fs`（与 MCP 不是第九种能力同一个理由）。⑦非目标写清了：不是 RAG（无向量/embedding）、不是 Agent Skills、不做多用户与自动遗忘。⑧分解 S4.2–S4.6，验收含**跨会话召回评测**（简历数字来源）。 |
| **S3.4 长会话压测 + 保留评测** | 完成 | ①**真模型信息保留评测**（`@cubus/evals` 新增 `eval:retention`，脚本 `src/retention.ts`）：逐轮种下事实 → 窗口小到触发压缩 → 压缩后逐条提问 → 按关键片段判分，结果写 EVALS.md + evals-retention.json。实测：窗口 4000 / 8 条事实 / 压缩 3 次 → **8/8 = 100%**；窗口 2500 / 12 条事实 / 压缩 12 次 → **12/12 = 100%**。口径已写清：只衡量"短而独特的事实"，长文事实与多跳问题**还没测**，不该读成"任意压缩都无损"。②**长会话压测**（`test/soak.test.ts`，假模型、16 毫秒、CI 每次跑）：200 轮 × 约 1k token，断言峰值投影从未超过窗口、压缩 10 次以上、边界单调前进（不反复摘要同一段）、日志一条没少。③**真模型评测抓到一个真 bug（已修）**：原 `snapKeepFrom` 只处理"边界落在 tool/result 上"，边界落在 **tool/call** 上时保留区里有工具结果却没有带 tool_calls 的 assistant，DeepSeek 直接 400（`Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`）。现在规则改为**边界一律吸附到 step 起点**（assistant/tool_call/tool_result 同进同退），并补了"边界落在 tool/call 上请求仍合法"的测试。教训：假模型不校验工具调用链，**真模型评测是设计的一部分**。④**README 新增"亲手验证上下文压缩"一节**（3 分钟：造大文件 → 配 `contextWindow: 4000` → 起工作台 → 看截断卡片与压缩行 → 用一条 node 命令证明日志没少 → 跑保留率评测）。⑤设计文档补 §7.3（保留评测数据）、§7.4（压测口径）、§7.5（真模型抓到的 bug）。测试：session 包与策略包更新，全量 **426**。 |
| **S3.3 压缩策略与钩子** | 完成 | ①循环新增可选钩子 `LoopConfig.beforeRequest`（`step/start` 之后、`request/header` 之前 await 一次；缺省时事件序列与从前逐字一致，有测试钉住）；运行时用**字符串查找**晚绑定到 `ctx.contextCompaction`（内核不 import 任何策略包），`config.loop.beforeRequest` 可覆盖。②`ContextCompactionPolicy`：usage 锚点 + 尾部估算 > 窗口 × 0.8 才压；保留边界从尾部回走（下限 keepRecentTokens/minKeepMessages、硬上限 maxKeepTokens，最后经 `snapKeepFrom` 配对吸附）；**必须有进展**（比上一个边界更靠后）否则跳过；摘要失败重试 2 次→放弃本次压缩继续任务，连续 3 次熔断；空摘要视为失败。③摘要请求也进日志：`context/compacted` 的 `input:{from,to,template}` 指代输入区间、`usage` 记真实用量、`before/after` 记估算。④**端到端实测**（真模型 + 88KB 文件 + 窗口调到 4000）：压缩 1 次、keepFrom=46、usage 2578/78、before 5185 → after 101；第 2 次请求的首条消息就是摘要 ✓。⑤实测打出并修掉的三个缺陷：**保留预算必须由窗口推导上界**（窗口 3k 时保留 8k 尾巴是荒谬的；硬上限优先于"至少保留 N 条"）、**摘要输入不能被原始工具输出淹没**（88k 的工具结果让摘要只总结出"全是占位符"，现在工具结果只留 400 字符预览、全文仍可读回）、**模板要禁止工具调用标记**（真实模型会吐出 DSML 标记并被原样带进下一次上下文）。输入上限也从"只留结尾"改成两头都留、省略中间。⑥接线：工作台与 CLI 都套 `withContextCompaction`；CLI 新增 `--context-window`（缺省 128k）。测试：循环 +2、新包 +8（含小窗口预算、摘要输入不被工具结果主导、模板禁令）。 |
| **S3.2 工具结果预算** | 完成 | ①**投影层截断**（core/session 的 replay.ts，纯函数）：单条超过 24k 字符 → 首尾各 8k 预览 + 「工具输出被截断」标记 + 读回指引（含 tool/result 的 id）；同一 step 合计超过 96k 字符 → 从最长的开始换，直到回到预算内（不同 step 各算各的）。**日志不受影响**：全文仍在事件里（测试断言「日志 88k、投影 16k」）。阈值是**投影规则常量**而非配置项 —— 配置化会让同一份日志在不同机器上重建出不同请求；改它们属于「要记一笔的变更」，已写进 versioning.md §2 第 7 条。②新包 @cubus/context-compaction：read_session_log 工具（tool_output 按 id 分页读回全文，单次上限 16k 字符；messages 列出某段日志的原始消息，最多 40 条、每条 300 字符预览），inject 了 sessionLog 与 tools、只读本会话；withSessionLogTools(recipe) 装饰器负责扩声明 + 挂载（与 MCP 装饰器同一套路）。③产品接线：cubusCodingAgentRecipe 外面套 withSessionLogTools，产品工具面变成 5 个（CLI/工作台/评测的断言同步更新）；产品提示词写明「输出被截断时用 read_session_log 读回」。④**端到端实测**（88KB 文件 + 真模型）：日志 88,011 字符完整保留、投影 16,156 字符、真实 promptTokens 955 → 5,089（不截断要背约 2.4 万），模型靠保留的尾部直接答对、不需要读回。测试：session +4、新包 +4，全量 **414**。 |
| **S3.1 压缩词汇与投影** | 完成 | ①`SESSION_FORMAT_VERSION` **3 → 4**：新增事件 `context/compacted`（`summary` 模型可见 / `keepFrom` 投影边界 / `reason` / `input:{from,to,template}` 指向日志区间不重复存输入 / `usage` / `before,after`），按 versioning.md 的五步走（加类型 → 升版 → 检查投影 → 测试 → 更新文档），旧日志（v3 及更早）读法与今天一致；②投影规则（`deriveMessages`）取**最后一个**压缩边界：`[0, keepFrom)` 被 `summary` 替代、`keepFrom` 之后（含边界之后的追加）逐字保留，没有压缩事件时逐字不变；③新增纯函数 `snapKeepFrom`——边界落在 `tool/result` 上且其 `tool/call` 在边界之前时，把边界**前移**到那条 call，保证配对完整（生产者负责吸附后写进事件）；④投影自己**防御**：万一边界仍切断配对，孤立的 tool-result 被丢掉，重建的请求依然合法；⑤`deriveRequest` 因此自动带上摘要（请求是投影的结果，不是重放）。测试：session 包新增 6 条（摘要替代前缀、边界之后的消息叠加在摘要上、多次压缩取最后且旧边界不复活、`snapKeepFrom` 四情形、`deriveRequest` 带摘要），并把 SDK 公开面测试里写死的 `formatVersion: 3` 改为引用常量（下次升版不必再改测试）。 |
| **S3.0 压缩设计** | 完成（Draft，待评审） | docs/design/context-compaction.md：①立场"**事实归事实，投影归投影**"——日志永远完整，压缩只改从日志重建请求的那一步（纯函数、可复现）；②**第一层工具结果预算**在投影层截断（单条 >24k 字符 / 单步 >96k 字符 → 首尾预览 + `tool/result` id），配一个 `read_session_log` 只读工具从**日志**读回全文（分页），因此**不写溢写文件**、归档布局不变；③**第二层会话压缩**新增事件 `context/compacted`（`summary` 模型可见 / `keepFrom` 投影边界 / `reason` / `input:{from,to,template}` 指向日志区间而不重复存输入 / `usage` / `before,after`），投影规则取最后一个边界：摘要 + keepFrom 之后逐字保留，**配对安全**（边界落在 tool_use↔tool_result 中间时吸附并把调整后的值记进事件），`SESSION_FORMAT_VERSION` **3→4**；④触发用扩展现有的循环：`LoopConfig.beforeRequest?`（step/start 之后、request/header 之前 await，缺省不存在时行为与今天逐字一致），运行时晚绑定到 `ctx.get('contextCompaction')`；⑤**摘要请求进日志**（按你的决定）：输入以日志区间 + 模板版本表达，用量记 `usage`，投影跳过压缩事件本身；⑥失败：重试 2 次→放弃本次压缩继续任务、连续 3 次熔断、空摘要视为失败；⑦不做：溢写文件、overflow 错误分类（LLM seam 今天只有 `retryable`）、摘要质量自动打分。验收含长会话压测与**信息保留率评测**（简历第 4 条的量化口径）。 |
| **S2.5 真实 token 对比** | 完成 | 新增 `packages/apps/cli/examples/mcp-token-report.ts`（`pnpm run mcp:tokens`）：同一任务在 `eager` 与 `on-demand` 两档各跑一条**真会话**，结论全部从日志取（`request/header.tools` 的条数与字符数 + `usage.promptTokens` 真实计数）。实测（deepseek-chat，2026-10-13）：不调工具的任务里，8 工具 4270→1089（−74.5%）、40 工具 17614→1377（−92.2%）、**120 工具 50974→2097（−95.9%）**；真的调用工具的任务（120 工具、1 检索 1 调用、3 步）全量 157011 → 按需 7333（−95.3%）。**边界也量了**：按需模式检索那一步要付取回 schema 的钱，实测 +463（取回少）到 +1975（一次命中 5 个）token，全取回会反超全量。**两条口径警告**：①字符÷2.5 的估算高估（120 工具估 83337、实测 50974，实际约 4 字符/token），所以降幅一律用真实 promptTokens；②`native` 未参与对比（适配器不支持，配了报错）。脚本的边界说明是**数据驱动**的（调没调工具、检索代价多少都按本次实测打印）。 |
| **S2.4 工作台接线** | 完成 | ①`@cubus/mcp` 新增 `withMcpTools(recipe, { connections, contextWindow, configured? })`：**扩声明**（把 `tool_search`/`mcp_call` 加进 manifest.tools、把 `mcp` 加进 toolSources —— 声明面必须包含运行时可能注册的东西）+ **挂载**（先产品后 MCP 的提示词片段与工具贡献），产品身份与预算不受影响；②`buildMcpConfig` 产出进装配快照的事实（服务器名/传输/是否连上/工具数 + 模式 + 延迟数），**不含凭据**；③工作台配置新增 `mcpServers` 与 `contextWindow`（缺省 128k）与 `--mcp-mode`：启动时连接、装配前定模式、退出时按进程组关闭；④页面"装配："一行显示 `MCP 1/1 台 · 按需检索（延迟 120 个）`。**真实验证**：配 120 工具的假 MCP 服务器跑真任务 —— `request/header.tools` 只有 **6 个工具**（4 内建 + 2 元工具），模型自己走 `tool_search {"query":"echo"}` → `mcp_call {"tool":"demo__echo_tool_1",...}`，真实 promptTokens 2112 → 4091 → 4180（全量模式同样场景要带 ~83k token 的工具定义）。顺带修了假服务器的一处语义不一致（schema 里没有 `text` 字段却回显 `text`，导致模型按 schema 传参时回显为空）。测试：mcp 包 18 条（含"装饰器不动产品身份/预算"与"快照只记事实不记凭据"）、工作台配置新增 1 条。 |
| **S2.3 MCP 暴露与检索** | 完成 | `@cubus/mcp` 新增 expose.ts：①`decideExposureMode` —— 显式配置优先；配 `native` 而 provider 不支持延迟加载时**报错而不是静默降级**；缺省按体量（schema 估算 token < 上下文窗口 10% 走全量，否则按需）；②`planMcpExposure` 产出"注册哪些工具 + 清单文本"；③`tool_search`（关键词匹配或 `select:<限定名[,名字]>`，最多 5 个，返回名字/server/描述/input_schema，无匹配时给出例子与重试建议）与 `mcp_call`（限定名 `server__tool` 优先、短名唯一时也认、重名要求显式 server、未知工具报错并给已知名、远端 `isError` 抛错进 `ok:false`）；④`mountMcpExposure` 挂提示词片段与工具贡献 —— **两个元工具任何模式都注册**（模式由 app 按体量决定，manifest 是静态的，声明面必须与模式无关）。测试 16 条（含"按需模式下 tools[] 只有 mcp_call/tool_search、全量模式下远端工具带 `source: mcp` 且可直接调用"）。假 MCP 服务器的 schema 体量改成接近真实（单工具约 1.7k 字符），因为原来的 213 字符会让"百级工具挤占上下文"这个前提不成立、数字失真。可亲手跑 `pnpm --filter @cubus/mcp run demo:expose`（120 工具的实测：全量 ≈ 83k token 的工具定义 vs 按需 1.1k 清单）。 |
| **S2.2 MCP 连接层** | 完成 | 新包 `@cubus/mcp`（provider 层，**零新依赖**：自研最小 JSON-RPC 2.0 客户端 —— 仓库有供应链策略，而 MCP 只需要 tools 子集）：①**stdio** 传输（一行一条消息 + 增量行缓冲、id 配对、超时、stderr 尾巴进错误信息；子进程 `detached` 自成进程组，关闭时 `kill(-pid)` TERM→1.5s→KILL，**不留孤儿**）；②**Streamable HTTP** 传输（JSON 与 SSE 两种响应、`mcp-session-id` 会话回传、非 2xx 带状态码报错）；③`parseMcpServerConfigs` 严格解析（名字非空且唯一、transport 可按 url/command 推断、stdio 必须有 command、http 必须有 url、timeoutMs 正整数），配置错误在装配前失败；④`connectMcpServers` **失败不阻塞**：一台连不上只写进它自己的 `connected:false + error`，其余照常返回工具清单。测试 11 条（JSON-RPC 编解码与忽略通知/畸形消息、行缓冲跨切片、stdio 连接+发现 12 工具+调用+远端错误映射、关闭后进程真的消失且不再接受请求、`--fail` 与不存在命令分别报错、HTTP 会话 id 从第二个请求起回传、HTTP 500 报错）。可亲手跑：`pnpm --filter @cubus/mcp run demo`。设计备注：stdio **不走 subprocess seam**（seam 是一次执行语义，MCP 需要双工会话），写进 mcp-seam.md §6 与未实现清单。 |
| **S2.1 工具来源契约** | 完成 | 让"运行时才知道名字的工具"（MCP）与"声明 = 注册"这条硬不变量共存：①`@cubus/tool-registry` 的 `toolContribution(tool, { source })` / `register(tool, { source })` 接受可选来源标签，`snapshot()` 里带来源的工具多一个 `source` 字段（**不进工具定义、不进请求、不进投影**，只用于装配期校验与审计；空来源报错）；②`AgentRecipeManifest` 新增可选 `toolSources`、`ActualContributions` 新增可选来源映射，`verifyDeclarations` 只放行"来源已声明"的多余工具 —— 无来源标签的内建多余工具、以及来源未声明的工具**照旧失败**，越界项在错误信息里带 `(source x)`；③没写 `toolSources` 的产品行为与今天**完全一致**（现有三个 recipe 未受影响），`contractVersion` 保持 1（新增可选字段；旧构建不认识该字段会把动态工具判为 undeclared 而装配失败 = fail-closed）。测试：tool-registry +2、agent-recipe +4（含装配级两例：同一个工具，声明来源能装配 / 没声明则装配失败）。文档：recipe-capabilities.md §4/§5/§5.1 与 mcp-seam.md §3 同步。 |
| **S2.0 MCP 设计** | 完成（Draft） | docs/design/mcp-seam.md：①**MCP 是工具来源，不是第 9 类能力**（能力 = 环境能力，由 Host 提供；MCP 服务器清单作为 app 装配参数进去凭据的 `session/mount.config`，远端凭据走 credentials 接缝）；②调和"manifest 声明的工具名 = 实际注册"这条硬不变量（`verifyDeclarations` 是集合相等，动态工具会被判 `registered but not declared`）——工具贡献新增可选 `source` 元数据 + manifest 新增可选 `toolSources` 声明，校验区分"动态来源放行 / 其余照旧失败"，不写 `toolSources` 时行为与今天完全一致（旧构建遇到该字段会 fail-closed 而非静默放行，故 `contractVersion` 保持 1）；③三种暴露模式（`eager` / `on-demand` 按需检索 / `native` 原生延迟，后者需 provider 支持，当前 DeepSeek 配了就报错不静默降级）+ 阈值（schema 估算 token < 上下文 10% 走全量）；④**不新增事件类型**：清单进 system prompt（每次 `request/header.systemPrompt` 可重建）、schema 按需进 `tool/result`、调用是 `tool/call`+`tool/result`；⑤`tools[]` 在一个会话内不变（缓存前缀保护），不热重载；⑥测量用**真实 `promptTokens`** 与 `request/header.tools` 明细，并要求写明"降幅强依赖实际检索数、全部检索完反而更贵"的边界。 |
| **S1.6 预算时长语义** | 完成 | 亲手验证时发现：`BudgetPolicy.startedAt` 在**装配（打开会话）**时固定，而工作台一个会话可以跑很多次任务 —— 会话活了超过 `maxDurationMs`（默认 10 分钟）之后，**之后每次运行都会被判 `max-duration` 并取消**（实测：只跑了 45 秒的任务报 `elapsedMs` 2997 秒 + `tripped: max-duration`）。改成**回合窗口**：`turn/start` 开窗并清掉上一回合的结论、`turn/end` 冻结窗口、只有窗口开着才评估时长（步数/工具/token 仍是**会话级累计**，遵守 D1 的有意决定）；`elapsedMs` 现在表示"本次运行用时"，回合结束后冻结。验证：预算包 11 条单测（空闲不计时、回合结束冻结、新回合重开、计数跨回合累计、历史回放不开窗）+ 真实会话"等 20 秒再跑 0.6 秒任务"得到 `elapsedMs: 576` 且无 `tripped`；**同一个出问题的会话**恢复后预算变成 `{steps:4,toolCalls:2,tokens:9482,elapsedMs:0}`。顺带：工作台 meta 行改为"用量/上限"（`步 4/40 · 工具 2/60 · tokens 9482/200000 · 0.6s/600s`），并补了"**继续此会话**"入口 —— 服务端重启后历史会话在本进程里是"没打开"的，原先只有 `needsSettlement` 才给恢复按钮，直接运行会被拒（`session not found`）。 |
| **S1.5 工作台 UI** | 完成 | 界面重做（零构建仍是硬约束）：明暗两套调色板（`prefers-color-scheme`）、顶栏品牌 + 产品身份徽章 + 连接指示灯、会话列表（单行截断 + 待恢复/日志问题角标）、对话区排版（用户/助手/思考三种行、工具卡片带参数与输出、事件标记统一为虚线标尺、token 行等宽字体）、空状态文案。**顺带修一个真 bug**：待回答的审批原先内联在 transcript 里，而 transcript 会被整份日志回放（顺序由日志决定），刷新页面后卡片被埋进历史中部、用户看不见 —— 现在审批移入 `#approvals` 固定区域（易失的实时状态与可回放的日志分开），解决后 3 秒自动收起。验证方式：headless Chrome 截图三态（浅色/暗色/带审批卡）逐张核对 + 全量 check 绿。 |
| **S1 产品身份** | 完成 | 从冻结版另起 `feat/coding-agent` 分支：新增 @cubus/recipe-cubus-coding-agent（产品 id `cubus-coding-agent@0.1.0`、自己的提示词、四工具、审批默认 `ask`），CLI 与工作台改为装配该产品——装配快照因此能回答"这次跑的是哪个产品"。产品包**只声明**（提示词/工具面/审批档/预算），装配逻辑仍来自通用工厂 @cubus/recipe-coding-agent：`repair-eval` 与产品共用同一工厂，不复制装配。docs/design/coding-agent-product.md 增 §7（产品身份与验收）与 §8（目标能力 S2–S6 及各自的复现方式：每步都必须能用日志或评测出结论）。 |
| 地基债第三批 | 完成 | ①**取消不再留孤儿**：容器内命令改由 `setsid -w` 起独立进程组并记录组号，取消/超时后按组 `kill -s TERM -- -$p` -> KILL；`docker run --init` 让被杀孤儿被回收。真容器集成测试断言"取消后容器内无存活进程且容器仍可用"。②**镜像升级流程**：DEFAULT_DOCKER_IMAGE 的升级四步写进 sandbox ADR，并新增镜像预检集成测试（核对 sh/setsid/cat/rm/sleep 与全部边界）——镜像换代让假设失效时立刻红。③**容器上限**：Host 新增 maxContainers（默认 4）与 DockerContainerLimitError，超限快速失败、释放后名额回收（集成测试覆盖） |
| 地基债第二批 | 完成 | ①会话归属：ToolExecutionContext 加可选 sessionId（seam additive），循环从 runtime 插件的 session 描述符透传，审批项带 sessionId 并显示在工作台卡片上（实测与真实会话 id 一致）。②评测跑飞的可见性：预算本就由 recipe manifest 声明并被评测继承（40 步/60 工具/10 分钟/200k token，已核对真实评测日志的 mount.budget），缺的是"被拦住"与"答错"没有区分 -> EvalTaskOutcome 加 budgetTripped，控制台打 CANCELLED，EVALS.md 标 ⏱ 并在表头统计，机器可读结果保留该字段。③SDK 公开面补预算类型（BudgetState/BudgetTripReason/BudgetLimits），消费方不必再去 import 策略包 |
| P1 保留选择权 | 完成 | ①@cubus/sdk 与 @cubus/agent-recipe 的入口改成**显式导出**（不再 export *）；②新增公开面测试（public-api.test.ts：只用包名导入，跑通建产品->运行->回放->指标->归档，并自检没有相对导入）；③docs/design/versioning.md 把四个版本号（会话日志/契约/归档/包）的规则与强制手段收成一处；④新支撑包 @cubus/architecture-guard：依赖方向（内核不依赖产品/应用）+ 无循环 + 公开面无 export * + 无跨包相对导入，且自带"守卫非空转"的自证测试 |
| F3 日志归档 | 完成 | @cubus/sdk 新增 archive.ts：导出成**目录**（manifest.json + 原样 JSONL）+ 逐文件 sha256；导入前校验哈希与格式版本（过新拒绝）、id 冲突默认跳过（--rename 改名）；文件白名单写死（session.jsonl / session.meta.json）杜绝路径穿越；清理默认 **dry-run**（--yes 才删，删前列绝对路径），崩溃现场默认保留（判据是 planSettlement，不是猜字符串）。CLI：pnpm run archive -- --export|--import|--prune。实测：真日志导出 -> 移走原件 -> 导入 -> 指标逐项一致 -> 恢复并继续跑（真模型 17957 tokens）；顺带演示了装配不一致时恢复被拒（allow -> deny） |
| F4b 时间戳与循环级重试 | 完成 | 词汇：turn/start 与 turn/end 加可选 at（ISO）；新增 request/retry 事件；SESSION_FORMAT_VERSION 2 -> 3（新增事件类型算一次递增）。重试改为循环拥有（LoopConfig.retry + SDK options.retry）：每次重试写进日志，CLI/工作台/评测不再在适配器外套 withLlmRetry（避免双重拥有者）。指标补齐：重试率（重试/模型请求）与回合耗时（只算两端有时间戳的正常闭合回合，恢复结算的不计） |
| F4 观测指标 | 完成（5/6，费用待价目表） | @cubus/sdk 新增 metrics.ts（纯函数：回合/取消/恢复结算/步数/工具成功失败/审批拦截/按工具名/token 含缓存；分母为 0 的比率是 null 而不是 0）；pnpm run metrics -- --sessions <dir> [--json]（复用工作台配置里的 sessionsDir）；评测分数表新增 token 列（分数与成本同表）。真实数字：E5 的 ask 会话 12 次调用 / 5 次审批拦截 = 41.7% / 16648 tokens（缓存 79.9%）；E6 崩溃会话显示恢复结算 1 次。算不出来的两项：耗时（日志无时间戳）与重试率（llm-retry 不写日志），都需词汇/接线变更，待确认 |
| F1 配置与一键启动 | 完成（打包未做） | 新增 config-file.ts：~/.cubus/config.json（严格解析，拼错的键报错）；优先级 命令行 > 配置 > 默认；--init 生成模板（不覆盖已有，除非 --force）；--config/$CUBUS_CONFIG/XDG/HOME 四种定位；入口不再强制传参；README.md 面向上手（安全模型、日志位置、恢复、配置、已知边界）。实测：全新 HOME + 全新工作区下 --init -> 只跑 pnpm run workbench -> 真模型跑完一轮。**打包/分发（真正的一键安装）未做**：属发布物，按 AGENTS.md 要先讨论交付目标与回滚 |
| E6 恢复视图 | 完成 | 未打开的会话事件流退化为磁盘回放（末尾一行说明）；详情在会话未打开时不再假装有内存态；UI 给 needsSettlement 的会话加恢复按钮、把结算事件渲染成恢复补写、409 差异原样显示。实测：真模型跑到工具调用时 SIGKILL 服务 -> 重启看到 90 条历史与待恢复 -> 恢复产出三条结算事件 -> 同一会话继续跑完一轮 |
| E5 审批交互 | 完成 | @cubus/tool-approval 新增 createInteractiveToolApproval：ask 档等待页面回答、**超时默认拒绝**（默认 120s，含排队时间）、全局 FIFO 排队（默认同时 8 项）+ 队列名次、事件订阅；工作台新增 GET /api/approvals 与 POST /api/approvals/:id，SSE 推 approval 控制帧；UI 审批卡片（允许/拒绝 + 超时提示）；CLI --approval ask 与 --approval-timeout |
| 修复元数据泄漏 | 完成 | E5 实测发现真模型会去读 fixture.json/golden.json（参考修复与指纹！）；新增 copyFixtureRepo 统一复制路径并排除评分元数据，run.ts / golden.ts / 无 key 门禁 / harness 测试全部改用它，并有断言钉死工作区里没有这两个文件 |
| E4 差异视图 | 完成 | 新增 GET /api/sessions/:id/changes：运行前记 Git 基线、请求时按需算报告（不缓存报告本身），复用 A1 的 GitCliWorkspaceProvider；无基线/无工作区时 409 并说明原因；UI 运行结束后列出改动；手工比对与 CLI 同格式 |
| E3 真模型入口 + UI | 完成 | main.ts：凭据租约 -> DeepSeek 适配器、显式审批档（无默认）、会话目录必须在工作区外、只监听回环；ui/{index.html,app.js} 零构建单页：会话列表（待恢复/日志问题角标）+ 实时事件流（EventSource 自动续传）+ transcript 渲染 + token 用量 |
| E1a 工作台服务端 | 完成 | 新包 @cubus/workbench：GET/POST /api/sessions、GET /api/sessions/:id（摘要+快照+预算+运行状态）、POST .../run（202 异步）、GET .../events（SSE，先回放再订阅）、POST .../resume、GET /api/concurrency；SDK 新增 listSessions/readSessionSummary/readSessionEvents（容错 JSONL）+ replay()/sessionsDir；错误语义化映射 400/404/409/500 |
| D4b 评测集 30 任务 | 完成 | 夹具从 7 扩到 30（覆盖 boundary/logic/type-coercion/async/side-effect/error-handling/missing-branch 七类），suite 版本 1.1.0；套件清单与磁盘夹具集合由测试双向对齐；每个任务用真模型生成 golden |
| D4a 行为指纹与门禁 | 完成 | fingerprint.ts：行为指纹（判分 / 事件序列 / 工具序列 / 工作区文件集，来自 A1 只读 Git 报告）+ compareFingerprints 四条规则；harness 把夹具副本变成真 git 仓库并产出指纹；eval:real 报告门禁结果并因回归退出非零；eval:golden 显式重算（打印 diff、拒绝从失败运行生成） |
| D3b usage 与 token 预算 | 完成 | LlmUsage 进会话词汇（assistant/message.usage?，不进投影）；DeepSeek 适配器带 stream_options.include_usage 并解析末帧（含 cachedTokens）；Loop 落盘 usage；预算新增 maxTokens（读 usage 累计）；CLI 新增 --max-tokens 并打印 token 用量 |
| D3 恢复与结算 | 完成 | 词汇：turn/end.settled?、step/end.settled?；core/session 新增 settle.ts（纯函数规划 + 结算事件）与 meta.ts（SESSION_FORMAT_VERSION=2、sidecar 解析规则）；SDK 写 session.meta.json 并提供 resume()：身份校验 + 结算；预算跨崩溃续算 |
| D2 Eval Suite 制品化 | 完成 | fixtures/suites/repair-eval-v1.json 显式任务清单（含门禁档位）；loadSuite/validateSuite/resolveSuiteTasks；harness 入口校验 recipe 声明的套件已注册；评测结果写 EVALS.md + evals-latest.json（机器可读） |
| D1 评测/恢复 ADR | 完成（Accepted） | docs/design/eval-suite-and-resume.md：Eval Suite 一等制品 + 行为指纹与回归门禁 + 恢复与结算规则表 + sidecar 格式版本 + usage 字段 |
| C6 有界并发与队列 | 完成 | SDK 新增 ConcurrencyGate：跨会话并发上限（默认 4）+ FIFO 排队 + 等待超时（0 = 不排队）+ abort 出队；名额交接不经过空闲窗口；runtime.concurrency() 暴露名额与排队位置 |
| C5 预算策略 | 完成 | 新包 @cubus/budget：观察日志事件计数、超限调用 loop.cancel()、不新增事件；manifest.budget 默认 + app 逐字段覆盖，生效值进装配快照；CLI 新增 --max-steps/--max-tool-calls/--max-duration 并打印用量 |
| C4 Docker sandbox host | 完成 | 新包 @cubus/host-docker：会话级容器（--network none / 非 root / cap-drop ALL / no-new-privileges / 只读 rootfs + tmpfs / 内存·CPU·PID 上限 / 只挂工作区 / 无 docker.sock）；容器化 fs（docker cp）与 subprocess（docker exec）；镜像 pin digest 且 digest 进快照；Docker 不可用时集成测试显式 skip |
| C3 credentials seam + 环境白名单 | 完成 | 新包 @cubus/credentials（引用 + 租约 + 白名单发放）；LocalSubprocess 由名字黑名单改为最小环境白名单；Host 声明 credentials 能力（只有名字进快照）；CLI 经租约取模型凭据；DeepSeekAdapter 改用 ES 私有字段（JSON.stringify 不再带出 apiKey） |
| P4 Coding Agent profile | 完成（A 阶段收尾） | 下一步 P2：A1 Docker 沙箱入口（--sandbox docker + 预检）-> A2 打包分发（需先讨论交付目标/凭据/回滚）-> A3 CLI --resume -> A4 UI 日用化 |
| P5 共享安全层 | 未开始 | Docker 沙箱 provider + 陌生仓库/无人值守边界，供所有 profile 复用 |
| P6 Agent 工作台 | 未开始 | Web UI + 多 profile + 会话/任务/工具/审批/差异视图 |
| P7 个人交付 | 未开始 | 单机安装 + 重启恢复 + 有界并发 + 备份/观测 + 可选 PR/通知 |

**测试现状**：370 个测试全绿（pnpm run check 一键验证：typecheck + lint + test）。62 个测试文件、27 个测试包、28 个包，分支 `feat/coding-agent`（自 `Cubus-v1.0` 冻结版另起）。

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
7d. docs/design/workbench-protocol.md —— E 阶段设计：工作台事件流协议（SSE、续传、鉴权边界）（Accepted）；
7c. docs/design/eval-suite-and-resume.md —— D 阶段设计：Eval Suite 契约、行为指纹门禁、恢复与结算、格式版本（Accepted）；
7e. docs/design/mcp-seam.md —— S2 设计：MCP 作为**工具来源**（非能力类型）、动态工具与"声明 = 注册"不变量的调和、三种暴露模式、可重建的上下文路径、测量方案（Draft，待评审）；
7f. docs/design/context-compaction.md —— S3 设计：两层压缩（投影截断 + 会话摘要）、`context/compacted` 事件与投影规则、`beforeRequest` 钩子、信息保留评测（Draft，待评审）；
7g. docs/design/memory.md —— S4 设计：指令三层与优先级、指令全文进装配快照、记忆用 append-only JSONL（索引注入 + `recall_memory` 按需取回）、`remember_memory` 与后台提炼、跨会话召回评测（Draft，待评审）；
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
packages/policies/budget/          预算策略：步数/工具/时长/token 上限
packages/recipes/reference-agent/ 领域无关参考 Agent（add_numbers，无 fs/shell/repo）
packages/recipes/coding-agent/   正式 Coding Agent Recipe（受信工作区 + 四工具）
packages/recipes/repair-eval/     由 Coding Recipe 工厂派生的修复评测变体
packages/apps/cli/                Coding Agent headless CLI 应用入口（含运行前后只读 Git 变更报告）
packages/apps/workbench/          工作台：HTTP + SSE + 单页 UI + 指标/归档 CLI
packages/support/architecture-guard/ 仓库级守卫：依赖方向、公开面、跨包相对导入
packages/seams/llm/               模型接缝（只有契约 + 一个测试替身；实现见 providers）
packages/seams/git/               只读 Git 工作区状态 seam（Service Definition）
packages/evals/evals/             修复任务评测：fixtures/bug-repos/* 自描述夹具 + 无 key 门禁 + 真模型分数表
packages/providers/git-cli/       git CLI 只读 provider（走 subprocess seam）
packages/providers/llm-deepseek/   DeepSeek provider（一次请求）+ env/凭据接线（唯一一份）
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