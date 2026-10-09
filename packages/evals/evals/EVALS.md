# Repair Eval Scores

真模型修复评测的运行记录（追加式，保留历史）。
无 key 的假模型门禁在每次 push 的 CI 里运行（pnpm run check，见 test/fixtures.test.ts）。
生成命令：pnpm run eval:real（加 -- <fixture-id> 只跑一个）。

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

