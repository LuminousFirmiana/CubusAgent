# 评测契约与恢复语义

> 状态：Accepted（2026-10-09）。§7 记录了五项已确认的决定。这是 roadmap D 阶段（D1–D4）的设计依据。
> 前置：[recipe-capabilities.md](recipe-capabilities.md)（B 阶段，Accepted）、[sandbox-seam.md](sandbox-seam.md)（C 阶段，Accepted）。

## 1. 背景：两笔欠账

**欠账一：评测是「harness 里的约定」，不是产品契约。**

| 现状 | 证据 | 后果 |
|---|---|---|
| suite id 只活在两处代码里 | recipe 的 `evaluation.suite` 与 harness 的常量靠一个 assert 对齐 | 第三方无法知道"这个产品按什么计分" |
| 任务集靠目录扫描 | `loadFixtures()` 读 `fixtures/bug-repos/*` | 没有"这套 suite 包含哪些任务"的显式清单，也没版本 |
| 判分只有 exit 0 | harness 跑隐藏测试 | 行为回退（改了 prompt/工具但测试仍过）不会被发现 |
| 没有回归门禁 | — | 改一句提示词，没人知道行为漂了多少 |

**欠账二：进程崩溃后无法恢复。**

| 现状 | 证据 | 后果 |
|---|---|---|
| 日志可能停在未闭合区间 | 崩在 turn 中途 → 没有 `turn/end` | 读者无法判断"这个回合结束了没有" |
| 孤儿工具调用 | 有 `tool/call` 无 `tool/result` | 下一轮请求里 assistant 的 tool_calls 没有配对 → **provider 直接报错** |
| 内存状态只在进程里 | Loop 的消息投影每次从日志重算，但没人"接着跑" | 长任务一崩就得从头再来 |
| 日志没有格式版本 | 词汇表从 10 种涨到 11 种了 | 老工具读新日志只能靠猜 |
| 没有 usage | C1 决定 4 把 token 计费推迟到这里 | 费用无法统计 |

## 2. 决策摘要

1. **Eval Suite 是一等制品**：显式清单文件（含 id/version/任务列表/判分规则），manifest.evaluation 引用它，评测运行时校验其存在。
2. **Golden 只比行为投影**：事件类型序列 + 工具序列 + 工作区文件集 + 判分结果；**不比文本内容**（模型措辞天然会变）。
3. **恢复 = 重建 + 结算**：从日志重建消息投影，先结算未闭合区间，再继续；**已执行过的工具绝不重放**。
4. **孤儿工具调用必须补结算结果**：写一条"结果未知"的 tool/result —— 不是为了好看，而是协议要求（tool_calls 必须与 tool 结果配对）。
5. **格式版本用 sidecar**：`session.meta.json` 不动事件流（保住 "session/mount 是第一条" 的不变量）；usage 作为 `assistant/message` 的可选字段。

## 3. Eval Suite 作为产品契约（D2 实现）

### 3.1 形状

```ts
/** 一套评测 = 命名 + 版本 + 任务 + 判分方式（D2 落在 evals 包里，随代码走） */
interface EvalSuite {
  id: string                 // 'repair-eval-v1'（与 manifest.evaluation.suite 对应）
  version: string            // suite 自身的版本（任务集变化时递增）
  judge: 'hidden-tests'      // v1 只有这一种：跑任务的 testCommand，exit 0 即通过
  tasks: EvalTaskRef[]       // 显式清单（不再靠目录扫描）
}

interface EvalTaskRef {
  id: string                 // fixture 目录名（含 testCommand / 参考修复）
  /** 门禁强度：guardrails（默认）/ strict / subsequence —— 见 §4.2 与 §4.4 */
  gate?: 'strict' | 'subsequence' | 'guardrails'
  golden?: BehaviorFingerprint   // §4；缺省表示该任务没有 golden
}
```

### 3.2 判分与记录

- 判分：任务的 `testCommand` 退出码 0（v1 唯一判据；隐藏测试即判据）。
- 记录：每次评测运行追加一节到 `EVALS.md`（人读）+ 写一份机器可读的 `evals-latest.json`（供 D4 的门禁与将来的工作台消费）。
- 分层不变：**无 key 假模型门禁**（每次 push，必跑，回放参考修复）守管道；**真模型夜跑**（花钱）测能力。

### 3.3 注册与校验

- 注册表做成 **evals 包的模块级 API**（`loadSuite(id)` / `assertSuiteRegistered(...)`），由评测 harness 校验；
  不引入 `ctx.evalSuites` 服务：能力 kind 是闭集且没有"评测"这一 kind，而**评测上下文本身就是 harness**，校验放在这里既真实又不污染内核（实现时修正）。
- 运行时**不做**跨包套件注册检查（保持内核不依赖评测包）；只有评测上下文存在时才校验。

## 4. Golden trajectory 与回归门禁（D4 实现）

### 4.1 行为投影（BehaviorFingerprint）

Golden **不是**原始日志（含 id、时间、模型措辞，天然不可复现），而是一份从日志 + 工作区算出来的**行为指纹**：

```ts
interface BehaviorFingerprint {
  judge: 'pass' | 'fail'
  /** 事件类型序列（工具事件带名字与结果） */
  events: string[]            // ['turn/start','step/start','request/header','tool/call:read_file','tool/result:read_file:ok','assistant/message', ...]
  /** 只保留工具名的调用序列 */
  tools: string[]             // ['read_file','edit_file','bash']
  /** 工作区文件集（来自 A1 的 Git 报告）：路径 + 变更类别 */
  files: { path: string; kind: 'created' | 'modified' | 'deleted' | 'restored' }[]
}
```

**刻意不进指纹的东西**：工具参数与输出文本、助手回复文本、行数统计、耗时、会话 id、时间戳。理由是它们会因模型波动而变化，把它们放进门禁会让门禁变成"随机红灯"。

### 4.2 门禁判定（全过才算通过）

| # | 规则 | 说明 |
|---|---|---|
| 1 | `judge === 'pass'` | 硬性：功能必须仍然正确 |
| 2 | 文件集相等 | 路径与变更类别必须与 golden 一致（多改一个文件 = 越界，少改 = 没做完） |
| 3 | 工具序列 | **仅当档位为 `strict` / `subsequence` 时才比较**；默认档 `guardrails` 不比工具身份（§4.4） |
| 4 | 调用预算 | 工具调用总数 ≤ golden + 3（挡住"退化成暴力重试"） |

### 4.3 存放与更新

- 指纹文件随 fixture 提交进 git（`fixtures/bug-repos/<id>/golden.json`，小且可审）；
- 原始会话日志不进 git（体积），作为 CI artifact 归档，供人复盘；
- 更新 golden 必须**显式**（`pnpm run eval:golden -- <task>` 重算并打印 diff），避免"顺手刷新"把回归掩盖掉。

## 4.4 修订记录（2026-10-09）：工具身份不做默认硬门禁

**实测发现**。D4 首次用真模型跑门禁时，一次**判分通过、修复正确、工作区文件集与 golden 完全一致**的运行被判红：

```
golden: [bash, bash, bash, bash, read_file, read_file, bash, edit_file, bash]
实际:   [bash, bash, bash, bash, bash,            edit_file, bash]
gate FAIL: tools (subsequence): golden [...] is not covered in order by [...]
```

原因：这次模型用 `bash cat` 读文件而没有调用 `read_file` —— **行为等价，工具身份不同**。

**结论**：工具身份是**实现选择**，不是行为契约。把它当硬门禁会制造假红灯，而假红灯的直接后果是「团队开始无视门禁」（§10 列出的头号风险）。

**修订**：

1. 门禁档位改为 `guardrails`（默认）/ `strict` / `subsequence`：
   - `guardrails` = 规则 1（判分）+ 规则 2（文件集）+ 规则 4（调用预算），**不看工具序列**；
   - `strict` / `subsequence` 保留给「顺序本身有语义」的任务，按任务显式开启。
2. 工具序列仍然**记录**在指纹里，并在报告与 diff 里打印 —— 它是给人看的证据，不是自动判据。

**这个门禁现在能抓什么**（都有测试）：判分回退、越界改动（多改/少改文件）、退化成暴力重试（调用数 > golden + 3）。

**它抓不到什么**（诚实记录）：同样是修好但「不再自测」这类**过程性**退化。要抓它需要**任务级必需动作**（例如任务声明「必须运行过 node --test」），而不是全局序列匹配 —— 列为 D4 之后的候选工作。

## 5. 恢复与结算（D3 实现）

### 5.1 恢复的定义

恢复 = 用同一份日志、同一套装配，在新的进程里继续这个会话：

1. 读日志 → 校验格式版本（§6）→ 重建消息投影（`deriveMessages`，已有）；
2. **结算未闭合区间**（§5.2）；
3. 重新走一遍装配（能力协商 + 声明校验）；
4. **校验装配身份一致**（§5.3）；
5. 之后正常 `run()`，新事件追加在同一份日志后面。

### 5.2 结算规则（崩溃留下的尾巴）

| 日志尾部状态 | 恢复时动作 | 为什么 |
|---|---|---|
| 已闭合（`turn/end` 收尾） | 直接继续 | 无需干预 |
| 未闭合 turn | 追加 `turn/end`（带 `settled: true`） | 让"每个 turn 都闭合"成为可依赖的不变量；标记说明是恢复写的 |
| 未闭合 step | 追加 `step/end` | 同上，且不需要模型回复 |
| 孤儿 `tool/call`（有 call 无 result） | 追加 `tool/result`：`ok:false`，文本说明**结果未知** | **协议要求配对**：否则下一轮请求的 assistant.tool_calls 没有对应 tool 消息，provider 直接报错；同时不谎称成功 |
| 只有 `assistant/chunk`、没有 `assistant/message` | **不补**助手消息 | 崩溃前的流式片段无法证明完整；投影只认 `assistant/message`，因此它自然不进入后续请求。诚实做法是"不知道就不写" |

**不重放**：任何已记录的 `tool/result` 都不重新执行；孤儿 call 也不重放（我们不知道它是否已经在崩溃前产生了副作用）。**不自动回滚**：文件可能已被改了一半，回滚属产品决策，不在恢复语义里。

### 5.3 装配身份一致性

恢复时必须重新装配，但**只允许身份一致的装配**。比较字段：recipe id/version、能力清单（kind + provider）、权限档、预算上限。

- 一致 → 继续（**不追加第二条 `session/mount`**：那个事件的不变量是"唯一且最先"）；
- 不一致 → **拒绝恢复**并给出差异（例如"原会话在 docker 沙箱里，本次 Host 只有 local-unconfined"）。要换环境就开新会话，不能悄悄降级。

### 5.4 预算计数器在恢复后的语义

| 计数 | 恢复后 |
|---|---|
| 步数 / 工具调用数 | 从日志重算（累计，跨崩溃延续） |
| 墙钟时长 | 从恢复时刻重新计（崩溃期间不是"运行时间"） |

## 6. 日志格式版本与 usage

### 6.1 格式版本：sidecar 而不是事件

```json
// <session 目录>/session.meta.json（由运行时在装配前写好）
{ "formatVersion": 2, "createdAt": "2026-10-09T…", "recipe": { "id": "coding-agent", "version": "1.0.0" } }
```

- 为什么不放首行事件：会新增事件类型，并且和 `session/mount` 的"必须是第一条"冲突；
- 读取方规则：文件缺失 → 视为 **1**（D1 之前的日志）；`formatVersion > 支持版本` → **拒绝读取**并提示升级，不做静默降级；
- 版本号只在**破坏性**变化时递增（新增可选字段不算）：v1 → v2 是因为多了 `session/mount` 与 `mount.budget`；v2 → v3 是因为多了 `request/retry` 事件（**新增事件类型算一次递增**）。

### 6.2 usage（token 计量）

```ts
// assistant/message 新增可选字段（与 thinking 同类：additive）
usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }
```

- 来源：DeepSeek 的 SSE 末帧 `usage`（需要请求里带 `stream_options.include_usage`）；适配器把它带进 chunk，Loop 落到日志；
- 语义：usage 不是"模型可见内容"，而是**响应事实**——它同样满足"可以从日志重建"；
- 有了它，C5 的预算才能从"步数/时长"升级到 token/费用上限（D3 之后的小步）。

## 7. 已确认的决定（2026-10-09）

1. **turn/end 加可选 settled?: true**：恢复写下的闭合与循环正常收尾可区分，"每个 turn 都闭合"成为可依赖不变量。
2. **孤儿工具调用补一条结算结果**：tool/result 带 ok:false 与"结果未知"文本 —— 协议要求 tool_calls 与结果配对，留空会让下一轮请求直接失败。
3. **格式版本放 sidecar session.meta.json**：不动事件流，保住 session/mount 是第一条的不变量；缺失视为 v1，过高版本拒绝读取。
4. **usage 作为 assistant/message.usage?**：additive 可选字段（与 thinking 同类），属"响应事实"，不参与消息投影。
5. **恢复时装配身份不一致即拒绝**：打印差异并提示开新会话；不允许"以为在沙箱里其实在本地"的静默降级。

## 8. 非目标

- 不做跨进程/分布式恢复（单机、单进程内 resume）；
- 不重放副作用、不自动回滚崩溃前的半成品改动；
- 不做跨格式版本的自动迁移工具（只做"拒绝 + 明确提示"）；
- 不把模型文本、时间戳纳入 golden 对比；
- 不在本阶段做评测集的分布式并行执行（D4 只要求 30–50 个任务能跑、能比）。

## 9. 验收（D2–D4 证据清单）

| 验收 | 证据形态 |
|---|---|
| suite 是显式制品 | 声明了未注册 suite 的 recipe 在评测运行时被拒绝计分 |
| 门禁能变红 | 故意削弱 prompt（例如去掉"先跑测试再报告"）→ 某任务的工具序列/文件集与 golden 不符 → 门禁红 |
| 门禁不误报 | 同一个任务用真模型跑两次（措辞不同、工具顺序微调）→ 门禁仍然绿 |
| 恢复可继续 | kill -9 一个跑到一半的会话 → 重启恢复 → 日志补出 `settled` 闭合与孤儿结果 → 下一轮正常请求（投影里每个 tool_call 都有配对） |
| 拒绝降级恢复 | 原会话 sandbox:docker、恢复时只有 local-unconfined → 明确拒绝并打印差异 |
| 老日志仍可读 | 无 `session.meta.json` 的日志按 v1 读取；`formatVersion` 过高时拒绝并提示 |
| 费用可算 | 真模型跑完后能从日志算出 token 数（usage 已落盘） |

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 门禁太严 → 天天红灯，团队开始无视 | 只比行为投影；容差写死（§4.2）；每任务可降级到 `none` |
| 门禁太松 → 挡不住回归 | 用"故意削弱 prompt"的自证测试（§9）证明它真的会红 |
| 恢复语义被误解成"回滚" | 文档与 CLI 输出都明确：恢复 = 继续，不回滚；副作用可能已发生 |
| sidecar 与日志不一致（有人只拷了 jsonl） | 读取方把缺失当 v1 并记一条 warning；工作台显示"格式版本未知" |
| usage 字段被当成模型可见内容 | ADR 写明它属"响应事实"，不参与消息投影（投影只读 content/thinking/toolCalls） |
