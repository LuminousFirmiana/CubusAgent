# Coding Agent 产品契约

> 状态：Accepted（2026-08-24）。这是 P4 的产品边界，不修改通用 Agent 内核。
> 实现：**已落地** —— 通用工厂 @cubus/recipe-coding-agent 提供装配；**产品身份**在
> @cubus/recipe-cubus-coding-agent（id `cubus-coding-agent`，v0.1.0），CLI 与工作台装配的是它。
> 目标能力（MCP / 压缩 / 记忆 / 技能 / 多 Agent）见 §8，逐步落地。

## 1. 产品目标

首版 Coding Agent 面向单个开发者，在用户明确指定且信任的本地代码工作区中，根据自然语言任务读取和修改文件、执行命令、验证结果，并保存完整会话事实源。

它是 `Agent Host + coding-agent Recipe + CLI` 的一种产品装配，不是 CubusAgent 内核的新身份。

## 2. 用户入口

首个可用入口是 headless CLI：

```bash
pnpm run cubus -- coding \
  --workspace /absolute/path/to/project \
  --task "修复当前失败的测试" \
  --trust-workspace
```

CLI 负责：

- 解析和校验用户参数；
- 创建本地 LLM、JSONL、文件系统和子进程 provider；
- 选择并装配 `coding-agent` Recipe；
- 展示会话 ID、日志位置、工具结果摘要和最终回复；
- 用进程退出码表达配置错误或运行失败。

CLI 不实现 Loop、Tool、记忆或权限判断。它是应用入口，不是 Recipe；内部能力仍由插件和 provider 组成。

## 3. 信任与安全边界

S4.1 只支持受信本地工作区：

- `--workspace` 必须存在且是目录；运行前解析为真实绝对路径；
- 必须显式传入 `--trust-workspace`，否则不得创建模型或执行任何工具；
- 会话日志默认写入 `~/.cubus/sessions`，并拒绝放入工具可写的工作区；
- 文件工具把路径限制在工作区内；
- `bash` 以工作区为 cwd，但它不是安全边界，命令仍可能访问工作区外资源；
- 模型发起的子进程继续清洗名称含 KEY/SECRET/TOKEN/PASSWORD 的宿主凭据；
- API key 只由 CLI/Host 读取，不进入 Recipe、工具参数或会话模型内容。

`--trust-workspace` 只是用户知情确认，不等于审批或沙箱。即使已有逐工具审批，陌生仓库、无人值守任务和自动化执行仍必须等 P5 的 Docker provider。

## 4. 产品组成

```text
@cubus/cli
  -> @cubus/host-local          DeepSeek + JSONL
  -> @cubus/recipe-coding-agent prompt + read/edit/write/bash
  -> @cubus/sdk                 session.create / session.run / session.cancel
  -> @cubus/agent-recipe        Cordis 组合根
  -> session / loop / registry  通用内核
```

`repair-eval` 从正式 Coding Agent 的 Recipe 工厂派生，只替换 manifest 和评测提示词。两者共享工具装配，不复制 Loop。

## 5. S4.1 验收

1. 缺少 `--trust-workspace`、任务或有效工作区时，在任何模型/工具执行前失败；
2. 指定受信工作区后，ScriptedAdapter 能通过 CLI 路径修改文件并完成一个 turn；
3. 会话保存在用户指定或默认的 sessions 目录，CLI 返回可检查的 JSONL 路径；
4. CLI 使用正式 `coding-agent` Recipe，repair eval 继续通过；
5. 不修改 SessionEvent 词汇、Loop 行为或 JSON-RPC 方法。

## 6. P4 后续而非 S4.1

- S4.2：工具审批 seam 与 `ask / allow / deny` CLI 交互；
- S4.3a：模型错误分类与有界重试；
- S4.3b：工具执行取消、进程组终止与日志结算；
- S4.4：Git 变更报告；其后补更多 repair fixtures；
- S4.4：实时事件渲染、Git status/diff 工具与任务结束摘要；
- P5：Docker 沙箱、陌生仓库和无人值守执行；
- 后续：resume、compaction、长期记忆与工作台。

长上下文和记忆必须由真实轨迹驱动设计；任何进入模型的摘要或记忆仍需先记录，继续满足“模型可见当且仅当已记录”。

## 7. 产品身份：CubusCodingAgent（S1）

代码与产品不是一回事：`@cubus/recipe-coding-agent` 是**装配工厂**（声明面 + 挂载逻辑），
`@cubus/recipe-cubus-coding-agent` 是**产品身份**。CLI 与工作台装配后者，装配快照因此记录
`cubus-coding-agent@0.1.0`——"这次跑的是哪个产品"变成可从日志回答的事实。

产品包只声明四件事：提示词、工具面、审批默认档、预算（评测套件在 §8 的 S3/S6 注册）。
装配逻辑、能力协商、工具实现全部来自运行时，**产品之间不复制装配**：repair-eval 与
CubusCodingAgent 共用同一个工厂，差别只在声明。

验收：

1. 装配快照的 `recipe` 为 `{ id: "cubus-coding-agent", version: "0.1.0" }`；
2. 工具面与声明集合相等（read_file / edit_file / write_file / bash）；
3. 默认审批档 `ask` 且来源记为 `manifest`；
4. 产品提示词是产品自己的那一份，不再与通用 coding-agent 共享。

## 8. 目标能力与验收方式（S2–S6）

每一步都必须能用日志或评测复现结论，不接受"感觉更快/更省"：

| 步 | 能力 | 交付物 | 结论怎么来（可复现） |
|---|---|---|---|
| S2 | MCP 接入与延迟加载 | mcp provider + `tool_search` / `mcp_call` 两个工具 | 同一任务跑 eager 与延迟两条会话，比 `request/header` 的工具定义量与 `usage.promptTokens` |
| S3 | 两层上下文压缩 | 新事件类型 + 压缩 policy | 长会话压测 + 信息保留评测（压缩后仍能答出前缀事实的比例） |
| S4 | 跨会话记忆 | 指令分级加载 + 索引注入 + LLM 召回 + 提取子 Agent | 记忆注入全部可从日志重建（模型可见 ⟺ 已记录） |
| S4b | Agent Skills | SKILL.md 目录 + 清单注入 + `load_skill` 工具 | 清单常驻、正文按需加载各一条测试 |
| S5 | 权限规则 + 本地 OS 沙箱 | 规则 policy + bwrap/seatbelt provider（**fail-closed**） | 沙箱不可用即拒绝执行的测试；审批次数从日志统计 |
| S6 | 多 Agent 协作 | 子 Agent 工具（独立会话）+ git worktree 文件级隔离 + 文件邮箱 | 同一跨文件任务单 / 多 Agent 对比（耗时与正确率） |

两条不变式在整个过程中不放松：**任何进入模型请求的内容都必须能从日志重建**；
**沙箱/审批失败一律 fail-closed**（缺答复者按拒绝、缺沙箱拒绝执行）。
