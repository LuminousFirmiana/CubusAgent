# Repair Eval Scores

真模型修复评测的运行记录（追加式，保留历史）。
无 key 的假模型门禁在每次 push 的 CI 里运行（pnpm run check，见 test/fixtures.test.ts）。
生成命令：pnpm run eval:real（加 -- <fixture-id> 只跑一个）。

## 2026-10-09 05:36 UTC · deepseek-chat · 1 fixtures · 1/1 passed (100%)

| fixture | bug 类型 | 结果 | 耗时 | 会话日志 |
|---|---|---|---|---|
| add-bug | logic | ✅ | 5.6s | /var/folders/gl/dmnnkdn57j97smsm5xwph5j80000gn/T/cubus-eval-add-bug-qGkssY/sessions/673813f9-be7c-4d01-9979-5245b1b42079/session.jsonl |

总耗时 5.6s。未通过项需人工看日志定位（会话日志即完整轨迹）。
