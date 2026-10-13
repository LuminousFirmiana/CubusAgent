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
  "model": "deepseek-chat",
  "contextWindow": 128000,
  "mcpServers": [
    { "name": "demo", "command": "node", "args": ["/path/to/mcp-server.mjs", "--tools", "120"] },
    { "name": "remote", "url": "https://example.com/mcp", "headers": { "authorization": "Bearer ..." } }
  ]
}
```

优先级：**命令行 > 配置文件 > 默认**。配置路径：`--config` > `$CUBUS_CONFIG` >
`$XDG_CONFIG_HOME/cubus/config.json` > `~/.cubus/config.json`。拼错的键会报错（不会静默忽略）。

### 指令分层（不用配置，自动生效）

| 层 | 文件 | 说明 |
|---|---|---|
| 角色 | 产品提示词 | 代码里，随 recipe 版本 |
| 用户 | `~/.cubus/instructions.md` | 你本人的长期偏好（可选） |
| 项目 | 工作区根 `AGENTS.md`（兼容 `CLAUDE.md`） | 项目约定（可选） |

拼接顺序 角色 → 用户 → 项目，**越具体越优先**（项目层冲突时覆盖前面）。每层默认上限 8000 字符，
截断会**显式告诉模型**"这里被截断了"。三层全文（含路径与 sha256）都会写进会话的第一条
`session/mount` 事件 —— 换了文件以后仍然能重建"当时到底给模型看了什么"。

### 跨会话记忆（`~/.cubus/memory/memory.jsonl`）

一行一条 JSON，**文件就是唯一真相**（可以直接编辑/删除）：

```json
{"id":"m-2026-10-13-001","at":"2026-10-13T07:00:00.000Z","tags":["order"],"text":"order 默认超时 2500 毫秒","source":{"sessionId":"…","turnId":"…"}}
```

装配时只注入**最近 12 条的索引**（一行一条，含 id 与标签）；正文按需取回（`recall_memory`，S4.4）。
没有条目时提示词里不会出现空标题；文件里写坏的行只被计数跳过，不影响其余记忆。
想换位置用配置键 `memoryPath` 或命令行 `--memory <path>`。

### MCP 工具来源

`mcpServers` 里的服务器在工作台启动时连接（连不上只记 `failed`，不阻塞启动）：

- **工具定义怎么给**：默认按体量决定 —— 工具定义总量不到 `contextWindow` 的 10% 就全量放进工具列表，
  否则只给模型一份**工具名清单**，schema 由 `tool_search` 按需取、`mcp_call` 统一调用；
  用 `--mcp-mode eager|on-demand|native` 可显式指定（`native` 需要模型侧支持，当前 DeepSeek 不支持会直接报错）。
- **这次到底怎么装的**：装配快照（会话日志第一条）里记着 `mcp.servers`（名字/传输/连上没有/工具数）、
  `mcp.mode` 与延迟工具数 —— 页面顶部的"装配："一行显示的就是它。
- **凭据**：stdio 的 `env` 与 http 的 `headers` 由 app 读入，只有凭据**名字**进快照，值不进日志。

想亲手看：`pnpm --filter @cubus/mcp run demo`（连接层）与 `demo:expose`（两档模式的账）；
用真模型量一遍：`pnpm run mcp:tokens`（同一任务跑两档各一条会话，从日志取真实 `promptTokens`）。

实测（deepseek-chat，120 个 MCP 工具，不调用工具的任务）：全量模式首次请求 50,974 token，
按需模式 2,097 token（**−95.9%**）；真的调用工具时（3 步）全量 157,011 → 按需 7,333（−95.3%）。
两条必须一起说的口径：①按需模式要付"取回 schema"的代价，实测 +0.5k～+2k token，取决于一次取回几个工具，
全部取回后反而比全量更贵；②以上都是 provider 真实计数，字符 ÷ 2.5 的估算会高估（120 工具估 83k、实测 51k）。

## 命令行

```bash
pnpm run workbench -- --workspace /path/to/repo --approval allow --port 4173   # 不写配置也能跑
pnpm run cubus -- coding --workspace /path/to/repo --task "修好测试" --trust-workspace   # 一次性任务（不开页面）
pnpm run eval:real -- --task add-bug        # 真模型评测一个任务（需要 key）
pnpm run eval:golden -- --task add-bug      # 重新生成该任务的 golden（**记录当次真实轨迹**：
                                            # 换模型或换一次运行都会不同；CI 用的是 guardrails 级门禁，
                                            # 只看改动文件集与调用预算，所以不会因为轨迹不同假红）
# 会话日志默认在 ~/.cubus/sessions（CLI 与工作台一致）；用 --sessions 可以指到别处
pnpm run metrics                            # 拦截率/重试率/耗时/token
pnpm run archive -- --export /tmp/backup    # 备份（--import 恢复 / --prune 清理，默认 dry-run）
```

## 亲手验证上下文压缩（3 分钟）

想亲眼看到"**日志是事实、投影是视图**"，不需要读代码：

```bash
# 1) 造一个 88KB 的大文件（工具结果一定会被投影截断）
mkdir -p /tmp/cubus-demo && node -e "const fs=require('fs');const l=[];for(let i=1;i<=2000;i++)l.push(String(i).padStart(4,'0')+' 行：'+'x'.repeat(36));fs.writeFileSync('/tmp/cubus-demo/big.txt',l.join('\n')+'\n')"

# 2) 写一份配置：窗口调到 4000，好让压缩几步之内就发生
cat > /tmp/cubus-demo/config.json <<'EOF'
{ "workspace": "/tmp/cubus-demo", "approval": "allow", "contextWindow": 4000, "sessionsDir": "/tmp/cubus-demo/sessions" }
EOF

# 3) 起工作台，打开 http://127.0.0.1:4178
pnpm run workbench -- --config /tmp/cubus-demo/config.json --port 4178
```

页面里点「新建会话」，任务写：

> 用 read_file 读 big.txt，然后回答最后一行的开头数字

应当看到三件事：

1. `read_file` 卡片里写着"共 16156 字符，已省略"——**投影层截断**（单条工具结果超 24k 字符换首尾预览 + 读回指引）；
2. transcript 里出现 `上下文压缩：… 字摘要替代了前 N 条事件（估算 X → Y token，原因 threshold）`——**第二层压缩**；
3. 模型仍然答对，而且它可以用 `read_session_log` 把被截断的全文读回来。

再看日志本身（**一条都没少**）：

```bash
node -e "const fs=require('fs');const f=process.argv[1];const l=fs.readFileSync(f,'utf8').trim().split('\n').map(JSON.parse);console.log('日志里的工具结果:', l.find(e=>e.type==='tool/result').output.text.length, '字符');const c=l.find(e=>e.type==='context/compacted');console.log('压缩事件:', JSON.stringify(c))" /tmp/cubus-demo/sessions/*/session.jsonl
```

压缩之后还能记住多少？跑保留率评测（真模型，约 20 次调用）：

```bash
pnpm run eval:retention -- --facts 12 --window 2500   # 实测：压缩 12 次，保留率 12/12 = 100%
```

## 已知限制（诚实清单）

| 限制 | 现状 / 出路 |
|---|---|
| **本地档不是沙箱** | 命令以你的身份运行（装配快照里如实标注 `unconfined`）；要隔离用 Docker Host |
| **没有打包分发** | 当前是 monorepo 开发态：`pnpm install` 就是"安装"，需要 Node ≥ 22 与仓库源码 |
| **Docker Host 还没接进入口** | `@cubus/host-docker` 可用（有真容器集成测试），但 CLI/工作台还没有 `--sandbox docker` 开关 |
| **费用只有 token** | 日志完整记录 prompt/completion/cached token；换算成美元需要价目表（价格会变），由使用方决定 |
| **CLI 不能恢复会话** | 恢复（结算 + 续跑）目前只在工作台里；CLI 是一次性任务 |
| **工作台只监听回环** | 无鉴权、无 TLS；要对外必须先补安全前置（令牌 + Origin 校验 + 强制 ask + TLS） |
| **会话日志无索引** | 查询靠全量读；日志很大时指标/列表会变慢 |
| **评测夜跑需要凭据决定** | 真模型全量跑目前是手动命令；做成夜跑 CI 需要把 key 作为仓库 secret |
| **Windows 本地档是二等公民** | 进程树终止与行数统计在 Windows 上能力更弱；可靠隔离走 Docker |

## 给开发者

- 工程纪律（宪法、检查纪律、TS 风格、提交规范）：[AGENTS.md](AGENTS.md)
- 接手先读：[docs/handover.md](docs/handover.md)（状态、决策、坑、技术债、下一步）
- 路线图：[docs/roadmap.md](docs/roadmap.md)
- 设计决策（ADR）：[docs/design/](docs/design/) —— 能力协商、沙箱与凭据、评测与恢复、工作台事件流协议
- 版本规则（日志格式 / manifest 契约 / 公开 API / 归档）：[docs/design/versioning.md](docs/design/versioning.md)
- 一键检查：`pnpm run check`（typecheck + lint + test；CI 每次 push 跑同一入口）

### 已知边界（诚实清单）

- 本地档**不是沙箱**；Docker Host 尚未接到 CLI/工作台的 `--sandbox` 开关；
- 还没做打包分发（当前是 monorepo 开发态：`pnpm install` 即"安装"）；
- 审批项不带会话归属（并发多会话时只按工具名与参数区分）；
- 费用（美元）需要价目表：日志里只有 token 事实（含缓存命中），换算成钱由使用方决定。