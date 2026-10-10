# CubusAgent

一个**把 agent 的每一步都写进会话日志**的本地编码 agent。日志是唯一事实源：界面显示的、模型看到的、
花掉的 token、崩溃后恢复用的，全都是同一份 append-only JSONL。

三条命令跑起来：

```bash
git clone git@github.com:LuminousFirmiana/CubusAgent.git && cd CubusAgent
pnpm install                       # 依赖（Node >= 22；仓库锁了 pnpm 版本）
echo 'DEEPSEEK_API_KEY=sk-...' > .env
pnpm run workbench -- --init       # 生成 ~/.cubus/config.json（工作区默认当前目录）
# 编辑配置里的 workspace 指向你要改的仓库，然后：
pnpm run workbench
```

打开它打印的地址（默认 http://127.0.0.1:4173），在页面上写任务、看实时事件流、按需允许/拒绝工具调用。

---

## 它是什么

- **Cordis 插件化**：模型、会话日志、文件系统、子进程、沙箱、凭据、审批都是可替换的 seam；
  产品（Recipe）只声明"我需要什么能力"，由 Host 提供。换模型/换沙箱 = 换插件，不改内核。
- **会话日志即事实源**：每次模型请求的内容都能从日志重建（不变量：模型可见 ⟺ 已记录）；
  装配快照、token 用量、结算事件都在日志里。
- **崩溃可恢复**：进程被 kill 后重启，能接着跑（未闭合的回合会被显式结算，未落盘的工具结果记为"未知"）。
- **行为可回归**：修复类任务有 30 个夹具 + 行为指纹门禁（判分、改动文件集、调用预算）。
- **成本可算**：每次响应的 token（含缓存命中）都进日志。

## 安全模型（请先读这段）

| 机制 | 说明 |
|---|---|
| **审批档** | `--approval ask`（默认建议）在页面上逐次批准；`allow` 直接执行；`deny` 只记录不执行。**超时未回答 = 拒绝**（默认 120 秒）。 |
| **沙箱** | 本地档是 `unconfined`：**不是沙箱**，agent 的命令以你的身份运行。需要隔离时用 Docker Host（`@cubus/host-docker`，逐会话容器、无网络、只读根、资源上限）。 |
| **凭据** | API key 只经 credentials seam 的**租约**取出，用完即释放；子进程环境变量走白名单，密钥不会漏进 bash。 |
| **工作区边界** | 会话日志必须放在工作区**之外**（agent 能写工作区，日志不该在它射程内）。 |
| **网络暴露** | 工作台**只监听 127.0.0.1 且没有鉴权**；要暴露到回环之外，必须先补鉴权/Origin 校验/TLS（见 ADR）。 |
| **预算** | 步数、工具调用数、时长、累计 token 都有上限；超限取消并结算（`--max-*` 可调）。 |

## 会话日志在哪、怎么用

每个会话一个目录（默认在临时目录；配置里的 `sessionsDir` 可固定到别处）：

```
<sessionsDir>/<session-id>/
  session.jsonl       # append-only 事件流（唯一事实源）
  session.meta.json   # 格式版本（缺失 = v1；版本过高会拒绝读取）
```

- **看历史**：页面上点会话即可（没被本进程打开过的会话走磁盘回放）；
- **崩溃恢复**：列表里带"待恢复"角标的会话，点"恢复"——会补写结算事件，然后就能继续跑；
- **看用量**：会话详情里的 `budget`（步数 / 工具数 / token / 耗时）；
- **只读 API**：`GET /api/sessions`、`GET /api/sessions/:id/events`（SSE）、`GET /api/sessions/:id/changes`。

## 配置（~/.cubus/config.json）

```json
{
  "workspace": "/path/to/your/repo",
  "approval": "ask",
  "approvalTimeoutSeconds": 120,
  "port": 4173,
  "sessionsDir": "/path/to/session-logs",
  "maxAttempts": 3,
  "model": "deepseek-chat"
}
```

优先级：**命令行 > 配置文件 > 默认**。配置路径：`--config` > `$CUBUS_CONFIG` >
`$XDG_CONFIG_HOME/cubus/config.json` > `~/.cubus/config.json`。拼错的键会报错（不会静默忽略）。

## 命令行

```bash
pnpm run workbench -- --workspace /path/to/repo --approval allow --port 4173   # 不写配置也能跑
pnpm run cubus -- coding --workspace /path/to/repo --task "修好测试" --trust-workspace   # 一次性任务（不开页面）
pnpm run eval:real -- --task add-bug        # 真模型评测一个任务（需要 key）
pnpm run eval:golden -- --task add-bug      # 重新生成该任务的 golden 指纹
pnpm run metrics                            # 从会话日志算指标（拦截率/重试率/耗时/token）
```

## 给开发者

- 工程纪律（宪法、检查纪律、TS 风格、提交规范）：[AGENTS.md](AGENTS.md)
- 接手先读：[docs/handover.md](docs/handover.md)（状态、决策、坑、技术债、下一步）
- 路线图：[docs/roadmap.md](docs/roadmap.md)
- 设计决策（ADR）：[docs/design/](docs/design/) —— 能力协商、沙箱与凭据、评测与恢复、工作台事件流协议
- 一键检查：`pnpm run check`（typecheck + lint + test；CI 每次 push 跑同一入口）

### 已知边界（诚实清单）

- 本地档**不是沙箱**；Docker Host 尚未接到 CLI/工作台的 `--sandbox` 开关；
- 还没做打包分发（当前是 monorepo 开发态：`pnpm install` 即"安装"）；
- 审批项不带会话归属（并发多会话时只按工具名与参数区分）；
- 费用（美元）需要价目表：日志里只有 token 事实（含缓存命中），换算成钱由使用方决定。
