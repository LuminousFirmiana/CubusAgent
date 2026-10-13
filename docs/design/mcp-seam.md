# MCP 接入与延迟加载（工具来源）

> 状态：Draft（2026-10-10，S2.0）。落地前请评审 §3 的契约决定。
> 前置：[recipe-capabilities.md](recipe-capabilities.md)（能力协商与装配期校验，Accepted）、[coding-agent-product.md](coding-agent-product.md) §8（产品目标能力）。
> 实现：**大部分落地** —— S2.1（工具来源契约）、S2.2（连接层）、S2.3（暴露与检索：模式判定 + `tool_search` / `mcp_call` + 清单进 system prompt）已完成；S2.4（工作台接线与真实 token 数字）待做。

## 1. 目标与"怎么算做完了"

产品目标（简历方向）：**通过 MCP 接入外部工具，并按需延迟加载工具定义**，在百级工具场景下把工具描述占用的 token 降下来，且结论可复现。

做完的判据：

1. 能连上 MCP 服务器（stdio 与 Streamable HTTP），把远端工具变成可调用工具；
2. 三种暴露模式可切换（全量 / 按需检索 / 原生延迟），默认按体量自动选择；
3. **模型看到的每一份工具定义都能从日志重建**（不变量：模型可见 ⟺ 已记录）；
4. 同一任务跑"全量"与"按需"两条会话，能用日志里的真实 `promptTokens` 给出降幅数字（不是估算）；
5. 不新增事件类型、不新增能力类型、不改循环驱动。

## 2. 决定 1：MCP 是**工具来源**，不是第 9 类能力

`CapabilityKind` 描述的是**环境能力**（模型、日志、文件系统、子进程、git、沙箱、凭据、审批）——它们由 Host 提供、由 Recipe 声明需求、装配期协商。MCP 不是环境能力，而是**外部工具目录**：它和 `@cubus/tools` 同级，产出的东西是"工具贡献"。

因此：

- **不新增 `mcp` 能力 kind**（保持"8 类能力接缝"这一说法为真，也不需要动 `contractVersion` 的能力语义）；
- MCP 服务器清单作为 **app 装配参数**进入 `session/mount` 快照的 `config`（去凭据）：`{ mcpServers: [{ name, transport, connected, toolCount }] }`，于是"这次连了哪些服务器、连上几个工具"是可查事实；
- 远端凭据（server env / HTTP header）走 **credentials 接缝**：只有凭据**名字**进快照，值不进日志、不进模型请求。

被否掉的替代方案：把 MCP 做成 `CapabilityKind` + Host offering。理由：Host 是"这台机器能提供什么"，而 MCP 服务器是"这个产品配了哪些外部工具"，跟着产品/项目走，不跟着机器走。二者混在一起会让 `host-docker` 这种 Host 也必须理解 MCP。

## 3. 决定 2：动态工具与"声明 = 注册"不变量的调和

**冲突**：[`verifyDeclarations`](../../packages/core/agent-recipe/src/capabilities.ts) 要求 `manifest.tools` 与实际注册的工具名**集合相等**（多一个、少一个都装配失败），而 MCP 工具是运行时才发现、数量不定的。直接注册会被判 `registered but not declared`。

**解法**（两处 additive 变更，**已落地：S2.1**）：

1. 工具贡献带**来源元数据**：`toolContribution(tool, { source: 'mcp' })`（可选字段，缺省表示"产品自带的内建工具"）；工具注册表快照保留它。
2. manifest 新增**可选字段** `toolSources?: readonly string[]`（例如 `['mcp']`）：声明"本产品还会在运行时暴露这些来源的工具"。

已实现并通过测试：`toolContribution(tool, { source })`、`manifest.toolSources`、新的校验规则（含装配级用例：同一个工具，声明了来源能装配、没声明则装配失败）。契约细节见 [recipe-capabilities.md](recipe-capabilities.md) §5.1。

新的校验规则（其余不变）：

| 情况 | 判定 |
|---|---|
| 声明了但没注册 | **失败**（原样，防漏挂） |
| 注册了但没声明，且它的 source 在 `toolSources` 里 | 允许（动态工具的正常路径） |
| 注册了但没声明，且 source 不在 `toolSources` 里 | **失败**（原样，防"公开面悄悄变宽"） |
| 没写 `toolSources`（现有三个 recipe） | 与今天**完全一致**：注册了没声明就是失败 |

**契约版本**：新增可选字段，按 [versioning.md](versioning.md) §3.2 不升版，保持 `contractVersion: 1`。旧构建读到 `toolSources` 不会静默放行——它不认识该字段，于是动态工具仍会被判 `undeclared` 而**装配失败**（fail-closed），这正是我们想要的方向。若评审认为"校验规则变化"应升版，则升到 2 并保留 v1 分支（旧分支行为 = 今天的严格相等）。

## 4. 决定 3：三种暴露模式

| 模式 | 工具定义在哪 | 谁支持 | 用途 |
|---|---|---|---|
| `eager`（全量） | 全部进 `tools[]` | 所有 provider | 工具少（schema 总量低于阈值）时最省事、模型零额外步骤 |
| `on-demand`（按需检索） | **不进 `tools[]`**；模型调 `tool_search` 拿到 schema 文本，再调 `mcp_call` 执行 | 所有 provider | 百级工具；这是本产品的主路径 |
| `native`（原生延迟） | 留在 `tools[]` 但带 provider 侧延迟标志（如 Anthropic `defer_loading` + `tool_reference`） | 仅支持该 beta 的 provider | 将来接 Anthropic 时启用 |

**判定阈值**：MCP schema 字符总量 / 2.5 估算 token，低于上下文窗口的 10% 走 `eager`，否则走 `on-demand`；`native` 只能由显式配置开启（当前 DeepSeek 适配器不支持 → 配了也拒绝，不静默降级）。阈值与估算系数写进日志无关的常量并单测；**真正的结论数字不用估算，用日志里的 `usage.promptTokens`**。

三种模式的共同点：**`tools[]` 在一个会话内不变**。`tool_search` 与 `mcp_call` 在装配时就注册好，之后不再增删工具——因为 `tools[]` 是缓存前缀的一部分，中途改动会让整段历史缓存失效（参考实现实测：两万 token 历史下命中率 99.4% → 9.5%）。按需模式省下的正是"把百级工具定义塞进前缀"的成本。

## 5. 决定 4：模型怎么知道有哪些工具（且这条路径必须可重建）

- **工具名清单**进 **system prompt**（作为 prompt 贡献，在 MCP 连接完成后加入）：只有名字与一句话来源说明，没有 schema。清单在会话内**不变**（见 §6：不热重载），因此不破坏缓存前缀。
- **schema** 由 `tool_search` **按需**返回：作为该次工具调用的**结果文本**（`tool/result`），模型随后用 `mcp_call` 调用。
- **调用**是 `tool/call` + `tool/result`，工具名固定为 `mcp_call`，真实目标（server + tool）在参数里。

**不变量论证**：模型看到的 system prompt 在每次 `request/header.systemPrompt` 里 ✓；检索到的 schema 在 `tool/result` 里 ✓；调用参数与结果在 `tool/call` / `tool/result` 里 ✓。因此**不需要新增事件类型**，`SESSION_FORMAT_VERSION` 不动。

## 6. 决定 5：连接、凭据与生命周期

- **传输**：stdio（本地子进程）与 Streamable HTTP；SSE 作为 HTTP 的兼容回退。
- **时机**：app 在装配**之前**连接（或注入已连接的客户端），把结果（成功/失败、工具数）带进装配参数 → 进快照。连接失败**不阻塞装配**：告警 + 空清单 + 快照记录 `connected: false`。
- **凭据**：stdio 的 env 与 HTTP 的 header 由 credentials 接缝发放；快照与日志只出现凭据名字。
- **回收**：stdio 子进程随会话结束终止，按**进程组**终止（spawn 时 detached 自成进程组，关闭 `kill(-pid)` TERM → 宽限 1.5s → KILL），不留孤儿；HTTP 连接关闭。
- **实现备注（S2.2）**：stdio 客户端**不走 subprocess seam** —— seam 目前是"一次执行、拿结果"的语义，而 MCP 需要双工会话；要沙箱覆盖 MCP 子进程，得先把 duplex 会话加进 seam（列入未实现清单）。
- **不热重载**：会话中途不追加/移除 MCP 工具（清单与 `tools[]` 都保持不变）。服务器掉线时只让 `mcp_call` 返回错误，模型据此换路子——**工具面不抖动**优先于"实时反映"。

## 7. 测量方案与实测结果（S2.4 接线 / S2.5 数字）

1. 仓库内提供一个**本地 fixture MCP 服务器**（stdlib-only，N 个工具，工具描述与参数规模可配置），供集成测试与演示共用；
2. 同一任务、同一模型、同一工作区跑两条会话：`eager` 与 `on-demand`；
3. 从日志取结论：
   - `request/header.tools` 的**工具定义总量**（字符数 + 逐条明细）——延迟模式只剩两个元工具；
   - `assistant/message.usage.promptTokens`（provider 真实计数）——每步的差值；
   - 检索次数与检索到的 schema 量（`tool_search` 的 `tool/result`）。
4. 输出一张表（工具数 × 实际检索数 → 降幅），并**明确写出前提**：降幅强依赖"实际检索了几个工具"；全部检索完反而可能比全量更贵（schema 要以文本再进一次上下文）。这条边界必须写进 README，不许只报最好看的那个数。

### 7.1 实测（2026-10-13，DeepSeek deepseek-chat，真实 `usage.promptTokens`）

命令：`pnpm run mcp:tokens [-- --tools N] [--task "…"]`（同一任务跑两档各一条会话，从日志取数）。

**不调用工具的任务**（差额 = 工具定义的固定开销）：

| MCP 工具数 | 全量：首请求 prompt | 按需：首请求 prompt | 省下 |
|---|---|---|---|
| 8 | 4,270 | 1,089 | 3,181（−74.5%） |
| 40 | 17,614 | 1,377 | 16,237（−92.2%） |
| 120 | 50,974 | 2,097 | 48,877（−95.9%） |

**真的调用工具的任务**（120 工具，1 次检索 + 1 次调用，共 3 步）：

| 模式 | 三步 prompt | 合计 |
|---|---|---|
| 全量 | 50,986 → 52,965 → 53,060 | 157,011 |
| 按需 | 2,109 → 2,572 → 2,652 | 7,333 |

省 149,678 token（−95.3%）。**按需模式的代价**：检索那一步要付"取回 schema"的钱 —— 实测 +463（取回少时）到 +1,975（关键词一次命中 5 个）token，取决于一次取回几个工具；全部取回后总和会反超全量。

**两条口径警告（写进 README 的就是这两条）**：

1. 估算公式（字符 ÷ 2.5）**高估**：120 工具估算 83,337 token，实测全量首请求 50,974 —— 实际约 4 字符/token。所以任何降幅结论都必须用 provider 真实计数，别用估算。
2. `native`（provider 侧延迟）**没有参与对比**：当前适配器不支持，配了会直接报错（不静默降级）。

## 8. 不做的事（明确划掉）

- 不做 MCP 的 prompts / resources / sampling，只做 tools；
- 不做 OAuth 与浏览器登录流程；
- 不做工具名清单的热重载（见 §6）；
- 不在 v1 实现 `native` 模式的 provider 适配（没有支持的适配器）；配置里写了就报错；
- 不把 MCP 工具塞进 `manifest.tools`（它们运行时才知道）。

## 9. 分解与验收

| 小步 | 内容 | 验收 |
|---|---|---|
| S2.1 | 契约：工具 `source` 元数据 + `toolSources` 声明 + 新校验规则 | 单测：三种情况（缺声明失败 / 动态来源放行 / 无 toolSources 时行为与今天一致）；现有三个 recipe 不受影响 |
| S2.2 | 连接层：stdio + Streamable HTTP 客户端、服务器配置、`tools/list` 发现、失败不阻塞 | **已落地**：@cubus/mcp（自研最小 JSON-RPC 客户端，零新依赖）；11 条测试（含"关闭不留孤儿""连不上只记录不抛""HTTP 会话 id 回传"）；可亲手跑 `pnpm --filter @cubus/mcp run demo` |
| S2.3 | 暴露与检索：`tool_search` / `mcp_call`、模式判定、清单进 prompt | **已落地**：`decideExposureMode`（阈值 + 显式配置；`native` 无 provider 支持即报错）、`planMcpExposure`、`searchTools`（关键词 / `select:`）、`mountMcpExposure`；测试断言"按需模式下 `tools[]` 里只有两个元工具"、"全量模式下远端工具带 `source: mcp`"；可亲手跑 `pnpm --filter @cubus/mcp run demo:expose` |
| S2.4 | fixture server + 工作台接线 + 数字 | **接线已落地**：`withMcpTools` 装饰器 + 工作台 `mcpServers`/`contextWindow`/`--mcp-mode` + 装配行显示 `MCP 1/1 台 · 按需检索（延迟 120 个）`；真实任务下 `tools[]` 只有 6 个工具、模型走 `tool_search` → `mcp_call`。**数字（真实 promptTokens 的两档对比）留待下一步**（见 §7）。 |

每一步仍是：单测 + 集成测试 → `pnpm run check` 全绿 → 显式路径提交 → push → CI 绿 → 更新 handover。
