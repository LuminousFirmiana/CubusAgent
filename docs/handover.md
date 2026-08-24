# CubusAgent 交接文档

> 最后更新：P2 完成时（S2.2 毕业考试通过）。本文件是"接手这个项目的第一份读物"。

## 1. 这个项目是什么

**CubusAgent**：云端自主任务 agent。终极形态：接收需求 → 拉取/进入代码仓库 → 自主修改代码 → 提交 PR → 通过企业微信/钉钉/飞书通知，K8s 上规模化运行，本地前端可连接。

当前阶段（v1.0 开发中）：**内核与评测已完成，产品形态刚开始**。技术路线：自研内核 + vendored cordis 底座（B 路线，决策记录见第 7 节）。

## 2. 当前状态总览

| 阶段 | 状态 | 内容 |
|---|---|---|
| P0 地基 | 完成 | monorepo + 工具链 + CI + vendored cordis |
| P1 内核 | 完成 | 会话日志（宪法）+ turn/step 循环 + llm seam + cordis 插件化 |
| P2 首个形态 | 完成 | JSON-RPC SDK + 真实端到端修 bug（passed: true）+ 评测 harness |
| P3 Web | 下一步 | 事件流协议 + 前端 |
| P4 云流水线 | 未开始 | jobs / PR / 通知 |
| P5 安全 | 未开始 | 沙箱 provider + 审批（接外部用户的硬门禁） |
| P6 规模化 | 未开始 | K8s + 多租户（进入前必须重估） |

**测试现状**：61 个测试全绿（pnpm run check 一键验证：typecheck + lint + test）。15 个测试文件、9 个包、18 个提交、分支 Cubus-v1.0。

## 3. 五分钟接手地图（按顺序读）

1. AGENTS.md —— 工程纪律（宪法、检查、TS 风格、锁文件、vendoring），人和 agent 都遵守；
2. docs/handover.md —— 本文件；
3. packages/core/session/src/types.ts —— 宪法第一页：会话日志词汇表（9 种事件 + 投影规则）；
4. packages/core/agent-loop/src/loop.ts —— 循环驱动（turn/step 语义，约 200 行，必读）；
5. packages/seams/llm/src/types.ts —— llm seam 的接口定义；
6. packages/evals/evals/src/harness.ts —— 评测 harness（真实任务怎么跑、怎么判分）。

## 4. 架构一页图

```
宪法层  @cubus/session      append-only JSONL 日志 + 9 事件词汇表 + 投影纯函数
机制层  @cubus/agent-loop   turn/step 循环、inbox、取消、确定性回放
接缝层  @cubus/llm          LlmAdapter 接口 + Scripted（假）+ DeepSeek（真）
工具层  @cubus/tools        fs/subprocess 最小 seam + read/edit/write/bash 四工具
组合层  @cubus/cordis       vendored 底座：插件挂载、依赖注入、事件、可逆回卷
使用层  @cubus/sdk          JSON-RPC 2.0（内存/stdio 双传输）+ 会话运行时
评测层  @cubus/evals        修复任务 harness + fixture 仓库 + 隐藏测试判分
```

三条宪法铁律（改它们 = 改架构，必须讨论）：

1. 会话日志是唯一事实源；模型可见 = 已记录（任何进模型请求的内容都能从日志重建）；
2. 工具只摸 fs/subprocess seam，不直接碰磁盘（沙箱后置的抵押品）；
3. 新行为挂扩展点；改循环驱动本身要先讨论。

## 5. 仓库布局与常用命令

```
vendor/cordis/                    冻结的 cordis 快照（改动必须记账 vendor/README.md）
packages/core/session/            会话日志（事实源）
packages/core/agent-loop/         循环 + cordis 插件
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

## 7. 踩过的坑（务必遵守的教训）

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

## 8. 已知问题 / 技术债（接手后可以处理）

- run.ts 真模型评测：无重试、无预算上限（跑飞了只能手动 Ctrl-C）；失败后需人工读日志。
- 系统提示（CODING_AGENT_PROMPT）是 v1 文案，尚未系统化迭代。
- DeepSeek 适配器：无错误分类/重试（429/5xx 会直接失败）；thinking 字段归一化表（vLLM/Qwen 等）未做。
- 会话日志：无 SQLite/索引，查询靠全量读；无 SESSION_FORMAT_VERSION 信封。
- fixture 只有一个（add-bug）；评测集需要攒到 30-50 个 + golden trajectory 回归机制。
- 循环：取消只覆盖流式阶段，工具执行中取消未处理；无自动压缩。
- 权限：v1 全放行（allow-all 语义），审批 UI 与权限模式未做（P5）。
- 前端：不存在（P3）。

## 9. 下一步：P3 Web（预告）

S3.1 事件流协议（SSE/WebSocket + 客户端 SDK + 鉴权）→ S3.2 前端（会话列表 + transcript 回放渲染 + 输入框 + 工具卡片）。核心验收：UI 无状态——turn 中途刷新页面，重连后渲染与刷新前逐块一致（证明前端只是日志的投影）。

## 10. 对下一个接手者（人或 agent）的三句话

1. 先跑 pnpm install --frozen-lockfile 和 pnpm run check，必须全绿才能动手；
2. 改任何东西前先读对应包的测试——测试就是规格书；
3. 不确定时问"这件事挂哪个扩展点"，而不是"在哪里加代码"。
