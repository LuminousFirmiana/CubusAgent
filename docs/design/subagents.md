# 多 Agent：独立进程 + worktree 隔离（S6 设计）

> 状态：**Draft（S6.1）**，待评审。目标：让主 Agent 能把子任务**派给独立进程**，
> 每个子 Agent 有自己的会话日志、自己的文件工作区（git worktree），结果回到主 Agent。
>
> 参考：MewCode 课程第 13 章（SubAgent）、第 14 章（Worktree）、第 15 章（Agent Teams）。
> 参考它的**思路**，但每一处都换成适配我们 runtime 的做法（见 §2 的对照表）。

## 1. 我们要解决什么（与参考一致的前提）

单 Agent 的上下文会被"中间过程"污染：派出去的子任务需要的是一小块干净的上下文，
而不是父会话里几十次工具调用的残留。另一方面，**并行的子任务会同时改文件**，
分支只隔离了时间维度，隔离不了空间维度 —— 同一时刻两个进程改同一个文件就是灾难。

所以要同时要两件事：**上下文隔离**（独立会话日志）与 **文件隔离**（独立 worktree）。

## 2. 参考设计的思路 → 我们的适配

| 参考的做法 | 我们的做法 | 为什么改 |
|---|---|---|
| Agent 与 Tool 同构，把 Agent 包成一个工具 | 两个工具：`spawn_agent` / `wait_agent` | 我们已有 tool-registry + 声明扩声明机制；"派出去"和"取结果"分开才谈得上并行 |
| 两种创建模式：定义式（专家）/ Fork（继承父上下文） | **第一版只做定义式**（`.cubus/agents/<name>.md`） | Fork 要继承父上下文，而我们的不变量是"模型可见 ⟺ 已记录"——继承什么、怎么记进子会话，需要单独设计，不能顺手做 |
| RunToCompletion（跑完才返回，不交互） | 同样：`spawn_agent` 立刻返回 id，`wait_agent` 取结果 | 子 Agent 不跟自己的人类用户对话，它只对父负责 |
| 子 Agent 独立 Conversation / 独立 token / 独立权限记录 | **子 = 独立 SessionRuntime + 独立会话日志文件** | 这正是我们 runtime 的原生形态：一次装配 = 一条日志 = 一份装配快照 |
| 结构化输出方便父解析 | 子进程最后一行 stdout 是 JSON：`{ sessionId, summary, changedFiles, worktree }` | 父要能机器解析，不能靠"读一段散文" |
| 工具过滤多层防线（排除 Agent/Edit/Write/Bash） | **depth 上限**（默认 1：子不能再生子）+ **按定义声明的工具白名单** + 权限规则照旧生效 | 我们的权限是"规则 + 档位 + 沙箱"三层，子 Agent 不绕过任何一层 |
| Worktree 空间隔离；**不切进程 cwd**（踩过坑：cwd 是全局可变状态） | 每个子 Agent 一个 `git worktree`，**cwd 设在子进程上**（`spawn(cwd:)`） | 我们本来就是独立进程，天然没有"进程级 cwd 全局状态"这个问题 |
| slug 安全验证（防路径注入） | `^[a-z0-9][a-z0-9-]{0,40}$`，拒绝分隔符与 `..` | worktree 路径要拼进 git 命令与目录名，必须严格 |
| 退出时变更保护（未提交修改不能静默丢） | 子 Agent 结束时**先提交到自己的分支**；删 worktree 必须显式 `discard` | 子 Agent 几小时的工作不能被一个 remove 调用抹掉 |
| 三种执行后端（in-process / tmux / iterm2） | 只做 **process**（独立进程）；in-process 留给"快但隔离弱"的后续 | 你要的是"独立进程 + worktree 隔离"，先把这条做扎实 |
| 星型（SubAgent）→ 网状（Agent Team，共享任务列表 + 异步邮箱） | **第一版星型**：子只回父，子之间不通信 | Team 的协调底座（共享任务 + 邮箱 + 轮询）是另一个可控范围，见 §7 非目标 |

## 3. 进程模型

```text
父进程（主 Agent，已有 SessionRuntime）
  └─ tool: spawn_agent({ agent, task, isolation, background })
       ├─ 校验：depth、并发上限、slug、agent 定义存在
       ├─ git worktree add <sessionsRoot>/../worktrees/<slug> -B cubus/<slug>   （isolation=worktree）
       ├─ 起子进程：node --import tsx/esm <runner> --task <file> --cwd <worktree> ...
       │    └─ 子进程自己装配 SessionRuntime（同 recipe、收窄的工具集、同一份规则/记忆/技能）
       │         └─ 子会话日志：<sessionsRoot>/<childSessionId>/session.jsonl
       └─ 立刻返回 { id, sessionId, worktree }
  └─ tool: wait_agent({ id, timeoutMs }) → { ok, summary, changedFiles, commit, sessionId }
```

**为什么用独立进程**：子 Agent 崩溃/超时不会带走父；子 Agent 的沙箱档、cwd、环境变量互不干扰；
父只是"看结果"，不需要理解子的中间过程。

**为什么子进程自己装配**：装配是 runtime 的既有能力（能力协商 + 装配快照 + 校验），
子进程走同一条路径，就不存在"第二套装配逻辑"。

## 4. 结果契约（父能看到什么）

```jsonc
{
  "ok": true,
  "id": "sa-2026-10-21-001",
  "sessionId": "…",              // 子会话日志 id（可审计、可回放）
  "summary": "改了 3 个文件，测试通过",  // 子 Agent 的最终回答（第一段，≤ 2000 字）
  "worktree": { "path": "…", "branch": "cubus/fix-auth", "commit": "abc1234" },
  "changedFiles": ["src/auth.ts", "src/auth.test.ts"],
  "stats": { "steps": 9, "toolCalls": 14, "tokens": 38120, "ms": 64000 },
  "exitCode": 0
}
```

- 父的 `tool/result` 里放的就是这个 JSON（**父日志不复制子的过程**，只记结论与指针 —— 双份事实会在两边不一致时互相打架）；
- 失败时 `ok: false` + `exitCode` + `stderrTail`（最后 2000 字符）；worktree **保留**并标记 `.failed`，等父或人来处理。

## 5. 隔离与安全

- **文件隔离**：`isolation: "worktree"`（默认）→ 每个子一个 worktree；`"shared"` → 与父同一工作区（只用于只读任务，如代码审查）；
- **工具收窄**：子只拿到定义文件声明的工具；`spawn_agent` 在 depth ≥ maxDepth 时**不注册**（不是运行时拒绝，而是根本不给）；
- **权限继承**：子进程读同一份 `.cubus/permissions.json`、同一份用户指令/记忆/技能根；档位由父传参（默认与父相同）；
- **沙箱**：子进程默认 `unconfined`（worktree 已经隔离了文件），可选 `seatbelt`；**docker 档暂不支持嵌套**（容器里跑容器需要额外设计，写进非目标）；
- **预算**：每个子 Agent 有独立的步数/token 上限（父传，默认 20 步 / 200k token）；父的 budget 策略仍管总数；**并发上限默认 2**，超限直接拒绝 spawn（fail-closed，不排队）。

## 6. 生命周期与清理

| 时机 | 行为 |
|---|---|
| spawn | 建 worktree（已存在则复用并提示）→ 起子进程 → 返回 id |
| 子正常结束 | 工作区内 `git add -A && git commit -m "subagent: <task 摘要>"`（在**子分支**上）→ 父拿到 commit 与变更文件 |
| 子超时/崩溃 | 杀进程组（复用既有 cancellation 机制）→ 返回 `ok:false` → worktree 保留并标记 |
| 父合并 | 由父（或人）显式 `git merge cubus/<slug>`；**我们不做自动合并** |
| 清理 | `remove_agent({ id, discard: true })` 才删 worktree 与分支；`discard` 缺省 false（防误删） |
| 父进程退出 | worktree 与子分支**保留**（可审计、可续做）；孤儿清单进 handover 的技术债 |

## 7. 非目标（明确不做，避免范围膨胀）

- **Agent Team（网状、共享任务列表、异步邮箱）**：第一版是星型；Team 需要"共享任务 + 点对点消息 + 轮询"，是独立的一块；
- **Fork 式继承父上下文**：需要先回答"继承的上下文怎么进子会话日志"（否则违反不变量）；
- **in-process 后端**：轻量但隔离弱，等有明确收益时再加；
- **容器里跑子 Agent**（docker 嵌套）：需要 cgroup/镜像层面的设计；
- **自动合并**：合并决策必须由父的模型或人显式做；
- **跨机分布式**：只在本机。

## 8. 分解（一步一锁）

| 步骤 | 内容 | 验收 |
|---|---|---|
| S6.1 | 本文件 | 你评审通过 |
| S6.2 | `packages/policies/subagents`：agent 定义加载（`.cubus/agents/*.md`）+ worktree 管理（slug 校验、create/remove、变更保护）+ 子进程 runner（子自己装配、结果 JSON 契约） | 单测：slug 注入被拒、worktree 创建/复用/删除保护、结果契约解析、超时与崩溃路径；真跑一次子进程（脚本化模型） |
| S6.3 | `spawn_agent` / `wait_agent` / `remove_agent` 工具 + 声明扩声明 + depth/并发限制 | 单测：depth 超限不注册、并发超限拒绝、工具白名单收窄；真模型跑一次"父派子改文件、父看 diff" |
| S6.4 | 评测：同一组任务"父自己串行做" vs "派两个子 Agent 并行做"（耗时、步骤、token、正确率） | 真模型脚本 + `EVALS.md`；这就是简历里"多 Agent"的数字 |

## 9. 风险与诚实边界

- **成本**：每个子 Agent 是一次完整装配 + 独立上下文，token 不便宜；所以只在"任务边界清晰且能并行"时才值得派。
- **编排质量取决于父模型**：它可能派得太碎、或该派不派；S6.4 的评测要同时看"正确率"和"成本"，不能只看快不快。
- **孤儿 worktree**：父进程被 kill 时会留下 worktree 与分支；这是已知债务，第一版不自动清理（自动清理反而可能删掉有用的东西）。
- **两套日志**：父与子各自一条日志，父只记指针。审计时要"顺着 sessionId 跳过去看"，这是刻意的取舍（双份事实会打架）。
