# Agent Host 与 Agent Recipe 契约

> 状态：Accepted（2026-08-24）。这是 P3 通用 Agent 原型的装配边界。

## 1. 背景

当前内核已经是领域无关的：`Loop` 只理解会话、模型请求和工具调用，默认工具也只是用于验证闭环的 `echo`。但是组合入口仍把系统提示和工具数组作为构造参数传入，`SessionRuntime` 也直接挂载 LLM provider 与 loop。继续沿用这种方式，会让每个具体 Agent 的产品差异散落在启动代码里，无法真正做到 all is plugin。

P3 要解决的是装配问题，不是新增 Agent 能力，也不是先做 Web。

## 2. 术语

### Agent Host

Host 提供 Agent 运行所需的环境能力，例如：

- LLM adapter factory；
- session log provider；
- 文件系统、子进程、网络和凭据 provider；
- 会话目录、端口等部署配置。

Host 不决定 Agent 的身份、提示词或工具产品面。

### Agent Recipe

Recipe 是一种可运行 Agent 产品的完整装配配方。首版由 TypeScript 定义，是带稳定元数据的 Cordis 根组合，而不是新的插件运行时。

Recipe 负责选择和配置：

- prompt contribution 插件；
- tool contribution 插件；
- 记忆、策略和领域服务插件；
- 对 Host 能力的要求。

Recipe 不保存 API key 等凭据，不直接创建本地或 Docker provider。行为评测与 Recipe 包共置，但不进入运行时 manifest。

### Agent Runtime

Runtime 是组合根：它为每个 session 创建独立 Cordis context，先挂 Host providers，再挂 Recipe contributions，最后挂通用 agent loop，并通过 SDK 暴露运行能力。

## 3. 核心决策

### 3.1 内核与产品分离

`@cubus/session`、`@cubus/agent-loop` 和 `@cubus/llm` 不依赖任何具体 Recipe，也不能依赖 `@cubus/tools`。Coding Agent 的提示词、文件工具和评测只能存在于外围插件或 Recipe 包。

### 3.2 产品差异由 Cordis 生命周期拥有

Prompt 和 tool 都由插件注册。注册是 Cordis effect：插件卸载时贡献必须同步撤销。Recipe 只负责装配这些插件，不发明第二套生命周期。

### 3.3 每个 step 使用一个能力快照

step 开始时，loop 从注入的 capability resolver 获取一次快照：

```ts
interface StepCapabilities {
  systemPrompt?: string
  tools: readonly Tool[]
}
```

随后按固定顺序执行：

```text
resolve prompt/tools
  -> validate and freeze snapshot
  -> append request/header
  -> rebuild request from the log
  -> call model
  -> execute tool calls against the same snapshot
```

模型收到的 tool schema 和本 step 的工具执行器因此一一对应。插件在 step 中途发生变化，也不能改变已经发给模型的能力集合。

首版禁止 session 在 turn 运行中切换 Recipe。Runtime 在 session 创建时完成装配，并保持到该 session context 被卸载。

### 3.4 组装必须确定

- Prompt fragment 使用稳定 `id` 和显式 `order` 排序；同 order 以 id 排序。
- 重复 prompt id 与重复 tool name 均在模型请求前失败。
- Tool schema 顺序稳定，保证 request/header、缓存和测试可复现。
- Prompt 和 tool registry 返回只读快照，不暴露内部可变集合。

### 3.5 会话宪法不变

P3 不新增或修改 `SessionEvent` 类型。实际 provider、model、system prompt 和 tool schema 仍完整记录在每个 step 的 `request/header` 中，继续满足“模型可见即已记录”。

Recipe 身份的跨进程恢复等到实现 session resume 时再设计；若需要新增持久事件，必须单独讨论格式版本和迁移，不能借 P3 顺带修改词汇表。

## 4. 首版公开形状

具体 TypeScript API 在实现阶段以测试驱动收敛，但职责固定为：

```ts
interface AgentRecipeManifest {
  id: string
  version: string
  displayName: string
}

interface AgentRecipe<Options = void> {
  manifest: AgentRecipeManifest
  mount(ctx: Context, options: Options): Promise<void> | void
}

interface AgentHost {
  mount(ctx: Context, session: SessionDescriptor): Promise<void> | void
}
```

`mount()` 可以继续调用 `ctx.plugin()`；Recipe 本身不绕过 Cordis 注册服务或管理 disposer。

## 5. P3 验收

P3 至少提供两种 Recipe 装配：

1. `reference-agent`：不依赖文件系统、Shell 或代码仓库，通过领域无关工具验证模型/工具闭环；
2. `repair-eval`：把现有修 bug 提示词和四工具迁入 Recipe 装配，继续通过隐藏测试。

两者必须使用相同的 session、loop、SDK 与 JSON-RPC 方法。切换 Recipe 只能改变 prompt、tools 和外围能力，不能修改内核代码。

## 6. 非目标

P3 不实现：

- YAML/JSON Recipe 配置语言；
- 第三方插件市场或远程下载；
- session 中途热切换 Recipe；
- Web 工作台或 UI renderer 协议；
- 多租户、Kubernetes 或分布式调度；
- 新的 session 事件词汇。

这些能力只有在具体产品需求和相应行为测试出现后才进入设计。

## 7. 实现顺序

1. System Prompt Service；
2. Tool Registry Service 与 step 快照；
3. Session definition / JSONL provider 分离；
4. Recipe / Host 装配入口；
5. reference-agent 与 repair-eval 双 Recipe 验收。
