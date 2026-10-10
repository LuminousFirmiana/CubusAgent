# Recipe 声明式契约与 Host 能力协商

> 状态：Accepted（2026-10-09）。§14 记录了三项已确认的决定。这是 roadmap B 阶段（B1–B4）的设计依据。
> 前置：[agent-recipe.md](agent-recipe.md)（P3 装配边界，Accepted）。本文件扩展它，不取代它。
> 实现：**已落地** —— 能力协商、声明校验、装配快照与装配身份比较（恢复时拒绝不一致的装配）。

## 1. 背景：差在哪

P3 建立了 Host/Recipe 装配入口，但"产品契约"仍停留在代码里：

| 现状 | 证据 | 后果 |
|---|---|---|
| manifest 只有身份 | `AgentRecipeManifest { id, version, displayName }` | 外部工具（CLI 预览、工作台、评测）无法在**装配前**知道这个产品要什么、能用什么 |
| 产品面靠代码挂载 | `mount()` 里 `ctx.plugin(...)` 注册 prompt/tools | 声明与实现之间没有可校验的关系，两者会静默漂移 |
| 能力需求没有表达 | Recipe 收 `recipeOptions: { fs, subprocess, workspaceDir }`，由启动代码 `new LocalFs(...)` 造好塞进来 | "同一 recipe 换环境不改代码"无法证明；谁提供什么能力没有名字 |
| 能力供给没有清单 | `AgentHost.mount()` 直接往 ctx 挂 provider | 缺能力只能在第一次工具调用时炸，错误信息离原因很远 |

要解决的问题因此是三个：**声明产品面**、**声明能力需求**、**装配期协商且对不上就失败**。

## 2. 决策摘要

1. **声明是数据，装配仍是代码**：manifest 只放"名字与引用"（能力种类、prompt 片段 id、工具名、策略档名、评测套件 id），不放逻辑。分支、拼装顺序、工具实现一律留在 `mount()`。
2. **能力有稳定词汇表**：`CapabilityKind` 是封闭集合，每种 kind 对应一个既有或计划中的 seam；新增一种 kind = 新增 seam 实现，而不是加一行配置。
3. **Recipe 声明需求，Host 声明供给，运行时协商**：`host.capabilities()` 给出可提供的 offerings，运行时把 recipe 的 `requires` 与之匹配，只把**被选中的** offerings 挂进会话 ctx。
4. **装配期失败，不留半成品会话**：缺必需能力、需求歧义、声明与实现不符，都在 `runtime.create()` 内失败（无模型调用、无日志文件），错误类型化且文案可执行。
5. **装配快照是独立事件**（§8，已确认采用方案 B）：新增 `session/mount` 事件，作为日志第一条，记录 recipe 身份 + 解析后的能力清单 + 有效策略档；装配本身因此有生命周期记录。
6. **step 能力快照语义不变**（[agent-recipe.md](agent-recipe.md) §3.3）：模型可见的能力集合仍按 step 冻结；mount 快照是装配来源（provenance），不是第二个模型可见状态。

## 3. 能力词汇表（v1）

| kind | 语义 | features（示例） | 今天的提供者 | 引入阶段 |
|---|---|---|---|---|
| `llm` | 模型调用 | `tool-calling`, `streaming`, `thinking` | Host（app 造 adapter） | 已有 |
| `session-log` | 会话事实源 | `append`, `live-subscribe` | Host（`@cubus/session-jsonl`） | 已有 |
| `fs` | 受限文件读写 | `read`, `write`, `path-pinning` | Host（本地；将来容器） | 已有，B3 迁入 Host |
| `subprocess` | 命令执行 | `cancellation`, `process-group-kill` | Host（本地；将来容器） | 已有，B3 迁入 Host |
| `git` | 只读版本状态检查 | `read-only-report` | Host（`@cubus/git-cli`） | 已有，B3 迁入 Host |
| `sandbox` | 执行隔离 | `fs-isolation`, `network-deny`, `resource-limits` | Host（Docker） | P5 新增 kind |
| `credentials` | 凭据引用（非明文值） | 例如 `deepseek` | Host | P5 新增 kind |
| `approval` | 逐工具审批策略 | 无（策略档 ask/allow/deny 是声明与覆盖数据，不是能力特性） | app 装饰器（withToolApprovalHost） | 已有，B3 纳入协商 |

规则：kind 是**闭集**。想表达"我需要一个带 X 特性的 Y"，只能先在 seam 层真实存在 Y 与 X，再进这张表。

环境事实（不是能力）：workspaceDir 由 Host 随 fs offering 一起提供（ctx.workspaceDir），Recipe 在 mount 时读取；缺失即装配失败，不参与协商。

`CapabilityKind` 定义在 `packages/core/session/src/types.ts`：它会随装配快照进入日志，因此与日志词汇同源；`@cubus/agent-recipe` 引用它，需求/供给/协商逻辑仍在后者。

## 4. Manifest 形状（目标）

```ts
interface AgentRecipeManifest {
  contractVersion: 1              // manifest 契约版本；未知版本装配期失败
  id: string
  version: string
  displayName: string
  description?: string

  requires: readonly CapabilityRequirement[]

  prompt: { fragmentId: string }                       // 静态基座片段的稳定 id
  tools: readonly string[]                             // 声明的工具名集合
  permission: { profile: string }                      // 默认策略档；app 可覆盖
  evaluation: { suite: string }                        // 评测套件 id
  presentation: { label: string; description?: string; icon?: string }
}

interface CapabilityRequirement {
  kind: CapabilityKind
  features?: readonly string[]    // 需要的能力特性（子集匹配）
  required?: boolean              // 默认 true；false = 可选（缺了就降级，见 §6）
}
```

**进 manifest vs 留在代码**：

| 进 manifest（数据） | 留在 mount（代码） |
|---|---|
| 身份、版本、契约版本 | prompt 的动态拼装（含工具清单、工作区路径等运行时信息） |
| 能力需求（kind/features/必需性） | 工具实现与 JSON Schema（仍在 tool registry） |
| prompt 基座片段 id、工具名集合 | 策略的具体判定逻辑（manifest 只写档名） |
| 默认审批档名、评测套件 id | 领域服务、记忆、检索等插件装配 |
| 呈现意图（label/description/icon） | 任何条件分支、循环、IO |

B4 起所有 manifest 都是完整声明式契约（类型层面必填，legacy 装配路径已删除）。必填子集：`contractVersion`、`requires`、`prompt`、`tools`、`permission` —— 缺任何一项装配期报 `RecipeManifestError`。`description`、`evaluation`、`presentation` 保持可选。理由：快照要完整记录产品面，半套声明会让快照出现"未指定"的洞。

明确**不进** manifest：凭据值（只声明 `credentials` 需求）、Host/provider 选择（recipe 永不点名 host）、模型参数（属 app/部署决策；实际值由 `request/header` 记录）、YAML/JSON 编写方式。

## 5. 声明与实现的对应校验

装配完成、运行第一个 step 之前，运行时校验（全部 fail loud）：

| 校验 | 规则 | 失败类型 |
|---|---|---|
| prompt 基座 | `prompt.fragmentId` 必须已被注册 | `RecipeDeclarationMismatchError` |
| 工具集合 | 注册的工具名集合 **等于** `tools` 声明集合 | 同上，错误列出两侧差集 |
| 评测套件 | `evaluation.suite` 必须在评测包已注册（仅评测运行时校验） | 同上 |
| manifest 自身 | 字段合法性：契约版本可识别、kind 属于闭集、同名 kind 不重复、字符串非空、必填子集齐全 | `RecipeManifestError` |
| 装配快照 | config 必须是纯 JSON 值（拒绝类实例/函数）；会话必须有 session-log provider 才能记录快照 | `MountSnapshotError` |

理由：声明若允许与实现不同，"声明式"就退化成注释。集合相等比包含更严格也更可预测（插件多注册一个工具必须显式声明）。

## 6. 协商算法（纯函数，可单测）

```text
resolveCapabilities(requires, offerings, pins) -> { selection, optionalMissing }
```

1. 对每个 requirement：候选 = offerings 中 kind 相同且 `requirement.features ⊆ offering.features` 的项；
2. 候选 0 个：`required !== false` -> 抛 `CapabilityNegotiationError`（带 recipe id、缺失 kind/features、以及 host 实际能提供的清单）；可选 -> 记入 `optionalMissing`；
3. 候选 > 1：app 未 pin（`pins[kind]`）则**失败**（歧义必须显式消解，不静默挑一个）；pin 指向不存在的 provider 也失败；
3b. Host 未实现 `capabilities()` 而 recipe 声明了 requires：reason `undeclared-host`，文案直接说明。
4. 每种 kind 至多选中一个；`selection` 按 kind 名排序（确定性）。

`optionalMissing` 必须进装配快照，并在 CLI 输出一条 warning：可选能力缺失会改变产品行为，不能静默。

## 7. 装配流程

```text
runtime.create()
  -> host.capabilities()                     // 静态供给清单
  -> resolveCapabilities(recipe.requires, offerings, pins)
  -> host.mount(ctx, session, selection)     // Host 只挂被选中的 offerings
  -> recipe.mount(ctx, { capabilities, config })
  -> verifyDeclarations(...)                 // §5
  -> freeze mount snapshot
  -> 第一个 turn 时逐 step 取 prompt/tools 快照（§3.3 不变）
```

失败语义：任一步失败 -> dispose 该会话 ctx、`create()` 抛错、**不写会话日志**（一个没有内核的日志不可回放）。

## 8. 装配快照：新增 `session/mount` 事件（已确认：方案 B）

决定（2026-10-09）：装配本身要有生命周期记录——空会话（装配后未运行）也必须能回答"这套会话是按什么装起来的"。因此给会话日志新增第 11 种事件：

```ts
// packages/core/session/src/types.ts（宪法第一页）
| {
    /** 装配快照：本会话创建成功时记录一次，必须是日志的第一条事件。 */
    type: 'session/mount'
    mount: MountSnapshot
  }

export interface MountSnapshot {
  recipe: { id: string; version: string; contractVersion: number }
  capabilities: readonly MountedCapability[]     // 按 kind 排序，与协商结果一致
  optionalMissing: readonly CapabilityKind[]     // 声明为可选、但 Host 未提供的能力
  permission: { profile: string; source: 'manifest' | 'app' }
  config: unknown                                 // 必须可 JSON 序列化且不含凭据（同工具参数规则）
}

export interface MountedCapability {
  kind: CapabilityKind
  provider: string
  features: readonly string[]
}
```

不变量：

1. **唯一且最先**：每个会话至多一条，且是日志第一条；写在装配**成功之后**、任何 turn 之前。装配失败不写日志（见 §7）。
2. **不是模型可见内容**：投影（`deriveMessages`）忽略它；"模型可见 ⟺ 已记录"不受影响——它记录的是来源（provenance），不是发给模型的内容。
3. **确定性**：`capabilities` 按 kind 排序；同一套 recipe + host + config 产出同一份快照。
4. **可序列化、无凭据**：`config` 与工具参数同规则，写入前校验可 JSON 序列化。

兼容性：词汇表由 10 种增为 11 种。**旧日志（无 `session/mount`）仍然合法可读**（字段语义不变）；新日志由 B3+ 的代码读取。`SESSION_FORMAT_VERSION` 信封仍留到 D1，本阶段不加。

被否掉的方案 A（扩展 `request/header` 的可选字段）记录在此：它改动更小、不新增事件，但只能覆盖"至少发生过一次请求"的会话，装配本身没有生命周期记录——与 resume 的方向不一致，故不采用。

## 9. 与 step 快照的关系

- step 快照（§3.3）：每个 step 开始时解析一次 `{ systemPrompt, tools }` 并冻结；
- mount 快照（§8）：装配结果，整个会话不变；
- 两者都不改变"模型可见即已记录"：模型看到的内容仍由 `request/header` 的 `systemPrompt`/`tools` 完整记录，mount 快照只是补充来源。

## 10. 迁移映射（B4 已执行）

| 原 owner | 现 owner | 落地情况 |
|---|---|---|
| CLI 造 LocalFs/LocalSubprocess 塞进 recipeOptions | Host 的 fs/subprocess offerings | 已迁：Host 接收 app 的 workspaceDir 并自行构造 provider；Recipe 从 ctx.fs / ctx.subprocess / ctx.workspaceDir 读取，三个 recipe 的 recipeOptions 都是 undefined |
| CLI 造 GitCliWorkspaceProvider（A1） | 保持 app 级只读探测（未迁） | 理由见下 |
| withToolApprovalHost 装饰器 | approval offering + manifest 默认档 | 已迁：装饰器向 capabilities() 追加 approval，且只把属于自己的 selected offerings 转发给内层 Host |
| recipeOptions.systemPrompt 覆盖 | manifest prompt.fragmentId | 已删：提示词由 recipe 以固定片段 id 注册；评测 harness 不再传覆盖值 |
| 三个 recipe 直接注册 | 声明 + mount 双份 | 已迁：reference-agent / coding-agent / repair-eval 均声明 requires/prompt/tools/permission，装配期校验工具集合相等 |

**为什么 git 报告留在 app 级**：CLI 的变更报告要在**会话创建之前**拍基线（运行前快照），而 Host 能力只在会话 ctx 里可用。工作区路径本来就是 app 的部署输入，所以「运行前后各探一次工作区状态」是 app 的只读检查，不是会话能力。P5 引入容器化 Host 后报告路径要跟着进容器，届时把它提升为 Host 的 git offering，并配一个 app 侧取用入口（留到 D1 讨论）。

## 11. 验收（B2/B3/B4 的证据清单）

| 验收 | 证据形态 |
|---|---|
| 缺必需能力装配期失败 | 假 Host 不提供 `fs` -> `create()` 抛 `CapabilityNegotiationError`，文案含缺失 kind 与 host 可提供清单 |
| 歧义失败 | 两个 `fs` offering 且无 pin -> 抛错；pin 后成功且快照记录 provider 名 |
| 可选缺失降级 | `required: false` 且 host 不提供 -> 装配成功，`optionalMissing` 进快照，app 收到 warning |
| 声明/实现不符 | 注册工具集合与 `tools` 不等 -> `RecipeDeclarationMismatchError`，含两侧差集 |
| 同一 recipe 换 Host 零改动 | 同一 recipe 分别用 local Host 与假 Docker Host 装配：prompt/tools 一致，快照 provider 名不同；recipe 目录无 diff |
| 新 recipe 零内核改动 | 测试内定义一个仅存在于测试文件的 recipe 并成功装配运行；内核包无 diff（评审清单项） |
| 快照可复现装配 | `create()` 后日志第一条即快照，且与 recipe+host+config 推导出的值往返一致（B3 已在真实 JSONL 上验证） |
| 只挂被选中的能力 | Host 声明 3 项、recipe 只要求 2 项时，未选中项的 mount 不被调用（B3 已验） |
| 同 Runtime 换 Recipe 只换产品面 | reference-agent 与 repair-eval 在同一 Host/Runtime/协议上运行：事件序列一致，快照能力清单不同（B4 已验） |
| 默认档与 app 覆盖都进快照 | CLI 不给 --approval 时快照记 {ask, manifest}，给了则记 {deny, app}（B4 已验） |
| 装配失败可回卷 | recipe 挂载失败时无快照，Host 已挂能力与内核服务全部卸载（B4 已验） |
| 旧日志仍可读 | 无 `session/mount` 的既有日志照常投影与回放（回归测试） |
| 装配失败不写日志 | 协商失败时 `create()` 抛错且会话目录内无 `session.jsonl` |

## 12. 非目标

- 不引入 YAML/JSON Recipe 配置语言，不做远程下载或插件市场；
- 不做跨进程能力发现、版本求解或依赖图（kind 是闭集，匹配是子集判断）；
- 不允许 session 中途重新协商或热切换能力（沿用 §3.3/§3.4）；
- recipe 不点名 Host/provider，不做模型参数声明；
- B3 只新增 `session/mount` 一种事件（方案 B）；不新增其它事件类型，不加 `SESSION_FORMAT_VERSION` 信封（留 D1）；
- 不在本阶段动审批策略的判定逻辑（只把档名纳入声明与快照）。

## 13. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 声明漂移成"第二份实现" | §5 强制校验（工具集合相等、片段 id 存在）；评测套件 id 参与校验 |
| 可选能力造成静默降级 | `optionalMissing` 进快照 + app warning + 两条分支各有测试 |
| manifest 膨胀成配置语言 | §4 的"不进"清单 + §12；新增字段必须同时给出"装配期如何校验它" |
| 协商把启动代码变复杂 | 协商是纯函数 + 类型化错误；app 只多一个 `pins` 选项 |
| 迁移期间双份真相 | B4 一次性迁移三个 recipe，迁移后删除 `recipeOptions` 里的 provider 字段 |
| 词汇表增长带来读取方分叉 | `session/mount` 是纯增量事件：投影忽略它、旧日志仍合法；B3 补"旧日志回归"测试；格式版本信封留 D1 |

## 14. 已确认的决定（2026-10-09）

1. **装配快照**：采用**方案 B** —— 新增 `session/mount` 事件（§8）。理由：装配要有自己的生命周期记录，空会话也有；与 resume 方向一致。代价（词汇表 +1、格式版本留待 D1）已接受。
2. **prompt 声明粒度**：只声明基座片段 id（不重复放静态文本）；装配后校验该片段确实注册过。
3. **审批档默认值**：manifest 声明默认档（`permission.profile`），app 可覆盖；优先级 app > manifest，快照记录最终值与来源。
