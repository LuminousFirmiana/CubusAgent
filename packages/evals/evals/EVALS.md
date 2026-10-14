# Repair Eval Scores

真模型修复评测的运行记录（追加式，保留历史）。
无 key 的假模型门禁在每次 push 的 CI 里运行（pnpm run check，见 test/fixtures.test.ts）。
生成命令：pnpm run eval:real（加 -- <fixture-id> 只跑一个）。

注意：golden 记录的是**当次真实轨迹**（judge / 事件序列 / 工具序列 / 文件集）。同一模型重跑也可能不同
（实测：模型少读了三次文件）。因此门禁默认是 guardrails 级 —— 判分 + 改动文件集 + 调用预算，
**不比对工具序列**（strict 级只适合确定性回放，例如无 key 的参考修复）。

## 2026-10-09 05:36 UTC · deepseek-chat · 1 fixtures · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 耗时 | 会话日志 |
|---|---|---|---|---|
| add-bug | logic | ✅ | 5.6s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-add-bug-qGkssY/sessions/673813f9-be7c-4d01-9979-5245b1b42079/session.jsonl |

总耗时 5.6s。未通过项需人工看日志定位（会话日志即完整轨迹）。
## 2026-10-09 06:49 UTC · deepseek-chat · 1 fixtures · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 耗时 | 会话日志 |
|---|---|---|---|---|
| add-bug | logic | ✅ | 10.6s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-add-bug-kIiYto/sessions/ac3b274c-78bc-4ef3-b331-7a3619f5b27e/session.jsonl |

总耗时 10.6s。未通过项需人工看日志定位（会话日志即完整轨迹）。

## 2026-10-09 10:41 UTC · deepseek-chat · 1 tasks (suite repair-eval-v1 v1.0.0) · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 耗时 | 会话日志 |
|---|---|---|---|---|
| add-bug | logic | ✅ | 7.1s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-add-bug-Gh5Tkv/sessions/f4071996-28c9-4a58-a110-62d349b6f4b1/session.jsonl |

总耗时 7.1s。未通过项需人工看日志定位（会话日志即完整轨迹）。

## 2026-10-09 11:06 UTC · deepseek-chat · 1 tasks (suite repair-eval-v1 v1.0.0) · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 耗时 | 会话日志 |
|---|---|---|---|---|
| add-bug | logic | ✅ | 7.0s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-add-bug-cvDU8J/sessions/a9a10ce7-47c3-4eb6-b03d-39d7c9bc6e9c/session.jsonl |

总耗时 7.0s。未通过项需人工看日志定位（会话日志即完整轨迹）。

## 2026-10-09 11:24 UTC · deepseek-chat · 1 tasks (suite repair-eval-v1 v1.0.0) · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 门禁 | 耗时 | 会话日志 |
|---|---|---|---|---|---|
| add-bug | logic | ✅ | ❌ tools (subsequence): golden [bash, bash, bash, bash, read_file, read_file, bash, edit_file, bash] is not covered in order by [bash, bash, bash, bash, bash, edit_file, bash] | 7.0s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-add-bug-3jFF1L/sessions/8e02d0b2-fab8-4520-a0b7-1bf57b3e83a8/session.jsonl |

总耗时 7.0s。未通过项需人工看日志定位（会话日志即完整轨迹）。

## 2026-10-09 11:27 UTC · deepseek-chat · 1 tasks (suite repair-eval-v1 v1.0.0) · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 门禁 | 耗时 | 会话日志 |
|---|---|---|---|---|---|
| add-bug | logic | ✅ | ✅ | 7.0s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-add-bug-XofBa2/sessions/c415f3d8-849f-4ca8-8e88-c9c706d92acd/session.jsonl |

总耗时 7.0s。未通过项需人工看日志定位（会话日志即完整轨迹）。

## 2026-10-09 11:27 UTC · deepseek-chat · 1 tasks (suite repair-eval-v1 v1.0.0) · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 门禁 | 耗时 | 会话日志 |
|---|---|---|---|---|---|
| add-bug | logic | ✅ | ❌ files: missing [ghost.ts:created] extra [] | 7.1s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-add-bug-f0dNmg/sessions/05852ca2-219b-442b-8b82-a35cc388f1da/session.jsonl |

总耗时 7.1s。未通过项需人工看日志定位（会话日志即完整轨迹）。

## 2026-10-09 12:11 UTC · deepseek-chat · 1 tasks (suite repair-eval-v1 v1.1.0) · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 门禁 | 耗时 | 会话日志 |
|---|---|---|---|---|---|
| falsy-zero | logic | ✅ | ✅ | 6.3s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-falsy-zero-nJ0aBi/sessions/05661e9e-0020-45a3-908d-f5106fabf3b9/session.jsonl |

总耗时 6.3s。未通过项需人工看日志定位（会话日志即完整轨迹）。

## 2026-10-10 01:11 UTC · deepseek-chat · 1 tasks (suite repair-eval-v1 v1.1.0) · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 门禁 | token | 耗时 | 会话日志 |
|---|---|---|---|---|---|---|
| add-bug | logic | ✅ | ✅ | 10400 (8064 cached) | 6.7s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-add-bug-6moUeX/sessions/15a6ba7b-dfad-4f40-9724-728e6100fdfc/session.jsonl |

token 合计 10400（缓存 8064）—— 与分数同一张表，成本可跟分数一起看。

总耗时 6.7s。未通过项需人工看日志定位（会话日志即完整轨迹）。


### 上下文信息保留（S3.4）

- 2026-10-13T12:34:37.937Z · deepseek-chat · 窗口 4000 · 事实 8 条 · 压缩 3 次
- **保留率 100%**（8/8）

### 上下文信息保留（S3.4）

- 2026-10-13T12:36:41.061Z · deepseek-chat · 窗口 2500 · 事实 12 条 · 压缩 12 次
- **保留率 100%**（12/12）

### 跨会话召回（S4.6）

- 2026-10-14T02:06:49.793Z · deepseek-chat · 轮次 1 · 事实 5 条 + 临时状态 2 条 · 记忆条目 5
- **召回率 100%**（5/5） · **克制率 100%**（2/2） · recall_memory 调用 0 次

### 跨会话召回（S4.6）

- 2026-10-14T02:07:27.811Z · deepseek-chat · 轮次 1 · 事实 6 条 + 临时状态 2 条 · 记忆条目 6
- **召回率 100%**（6/6） · **克制率 100%**（2/2） · recall_memory 调用 0 次

### 跨会话召回（S4.6）

- 2026-10-14T02:08:09.450Z · deepseek-chat · 轮次 1 · 事实 6 条 + 临时状态 2 条 · 记忆条目 10
- **召回率 100%**（6/6） · **克制率 100%**（2/2） · recall_memory 调用 0 次

### 跨会话召回（S4.6）

- 2026-10-14T02:08:56.349Z · deepseek-chat · 轮次 1 · 事实 6 条 + 临时状态 2 条 · 记忆条目 6
- **召回率 100%**（6/6） · **克制率 100%**（2/2） · recall_memory 调用 1 次

### 审批打扰（S5.3）

- 2026-10-14T03:14:47.297Z · deepseek-chat · 文件 6 个
- 只有档位 ask：工具调用 14 次 → 打扰 14 次
- 档位 + 权限规则：工具调用 14 次 → 打扰 2 次（**下降 85.7%**）

### 技能有效性（S4b.4）

> 判分看产物（preflight 标记 / VERSION / CHANGELOG 条目），不看模型自评。

**第一轮：约定可从仓库推断出来**（版本号方案是常规的 minor 提升，格式也能从现有 CHANGELOG 看出）

- 2026-10-14T04:54:58.976Z · deepseek-chat ·
- 无技能：**3/3**（步 12 · 工具 18 · token 82113）
- 有技能：**3/3**（步 6 · 工具 7 · token 10301）

→ **正确率没有差别**（聪明的模型自己推出了约定），但**成本差 ~87%**（82k → 10k token）、步数减半。
这说明"技能的价值"要看任务：约定能被推断时，技能省的是**探索成本**。

**第二轮：约定无法从仓库推断**（版本号必须带 `-internal` 后缀 —— 猜不到）

### 技能有效性（S4b.4）

- 2026-10-14T04:55:34.877Z · deepseek-chat · 判分看产物（preflight / 版本号 / CHANGELOG 条目）
- 无技能：**1/3**（步 11 · 工具 17 · token 38171）
- 有技能：**3/3**（步 6 · 工具 9 · token 12643）