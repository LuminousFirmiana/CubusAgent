# AGENTS.md

CubusAgent 的工程纪律。人和 agent 都遵守；规则冲突时，更具体者优先。

## 宪法（改它 = 改架构，必须讨论后动）

- 会话日志是唯一事实源（append-only JSONL，词汇表在 `packages/core/session/src/types.ts`）。
- 不变量：**模型可见 ⟺ 已记录**——任何进入模型请求的内容都必须能从日志重建。
- 新行为挂在扩展点（事件/seam/工具注册）上；改循环驱动本身要先讨论。

## 检查纪律（一步一锁）

- 提交前跑 `pnpm run check`（typecheck + lint + test，任一失败即中断），**看退出码**，
  不要用 `| tail` 之类的管道吞掉结果。
- 每个包声明了 `test` 脚本就必须有测试文件（vitest 无测试文件会失败）。
- 测试断言**行为**，不断言实现细节；新增行为必须带测试。

## TypeScript 风格

- 相对导入必须带 `.ts` 后缀（NodeNext）；包间导入用包名（`@cubus/xxx`）。
- **Erasable syntax only**（Node 直接跑 TS 的前提）：
  - 禁止 `enum` / `namespace`；
  - 禁止构造器参数属性（`constructor(public x)`）——显式声明字段再赋值；
  - 这是踩过三次的坑，写新类时先检查构造器。
- 全 strict（`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 都开着），
  数组下标、可选字段按可能为 undefined 处理。

## 依赖与锁文件

- 任何 `package.json` 变化（加依赖、加包、改版本）之后，`pnpm-lock.yaml` **必须一起提交**。
- 本地自检：`pnpm install --frozen-lockfile` 通过 = 锁文件已同步。
- CI 上的 frozen-lockfile 是这条纪律的执行者，红了先查锁文件。

## Vendoring 政策

- `vendor/` 里的第三方源码是冻结快照；改动必须记账：`vendor/README.md` 记录
  来源（仓库/SHA/版本）、本地修改清单、同步重放步骤。
- vendored 源码有自己的 tsconfig 例外（bundler 解析、enum 允许），不与我们的
  严格设置混用；消费者读它生成的声明文件（`lib/*.d.ts`），不直接检查它的源码。
- lint 不覆盖 `vendor/`。

## 仓库布局与命名

- `packages/<group>/<pkg>`，包名 `@cubus/<pkg>`；`vendor/*` 留给 vendored 包。
- `references/` 是外部参考项目，**永不提交**（.gitignore 已排除）。
- 提交小步走：一个 commit 一个主题；`git add` 显式列路径，不用 `git add -A`。
- **提交前必须 `git status --short` 逐行核对**：每个改动文件要么进本次 commit，
  要么有明确的"不提交"理由（S1.3a 事故：源码漏提交而锁文件提交了，CI 红线才暴露）。

