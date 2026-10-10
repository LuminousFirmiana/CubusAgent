# 版本规则

> 状态：Accepted（2026-10-09，P1）。本文档把散落在各 ADR 里的版本约定收成**一处可查的规则**。
> 目的：半年后（或交给别人时）不用重新推演"什么算破坏性变更、读取方该怎么办"。
> 强制方式见 §5：规则不是靠人记得，而是靠测试。

## 1. 一共有四个版本号

| 版本号 | 在哪 | 管什么 | 当前值 |
|---|---|---|---|
| `SESSION_FORMAT_VERSION` | `<会话目录>/session.meta.json`（sidecar） | 会话日志的**词汇表**（事件类型与字段） | **3** |
| `contractVersion` | 每个 recipe 的 manifest | **产品声明契约**（manifest 必填字段与装配语义） | **1** |
| `ARCHIVE_FORMAT_VERSION` | 归档目录的 `manifest.json` | 归档包的布局 | **1** |
| 包版本（`package.json` 的 `version`） | 每个 workspace 包 | 公开 API（§4） | 全是 0.0.0（未发布） |

**它们互不替代**：日志格式变了不等于 manifest 契约变了，反之亦然。

## 2. 会话日志格式（`SESSION_FORMAT_VERSION`）

### 现状与历史
| 版本 | 变化 | 类型 |
|---|---|---|
| v1 | 最初的十种事件（无 `session/mount`、无预算） | — |
| v2 | 新增 `session/mount`（装配快照）；`mount.budget` 字段 | **新增事件类型** + 新增可选字段 |
| v3 | 新增 `request/retry`；`turn/start` 与 `turn/end` 加可选 `at` | **新增事件类型** + 新增可选字段 |

### 规则
1. **新增事件类型 = 升版**（读取方据此拒绝过新的日志）；
2. **新增可选字段 = 不升版**（旧读者忽略它即可；例如 `assistant/message.usage`、`tool/result` 之外的字段）；
3. **改名/删除字段/改变已有字段语义 = 升版，并且属于破坏性变更**：必须写迁移说明，并考虑是否提供兼容读取；
4. **sidecar 缺失 = 视为 v1**（D1 之前的日志），不报错；
5. **读到比本构建更新的版本 = 拒绝**并提示"升级工具，而不是降级日志"（`SessionFormatError`）。**不允许静默降级**；
6. 版本写在 sidecar 而**不是事件流里**：事件流的第一条永远是 `session/mount`（不变量），不能让版号挤掉它。

### 新增一个事件类型的步骤（照着做）
1. 在 `packages/core/session/src/types.ts` 的闭合联合里加类型（**每个字段都要有注释说明它是不是模型可见**）；
2. 把 `packages/core/session/src/meta.ts` 的 `SESSION_FORMAT_VERSION` +1，并在上表补一行；
3. 检查投影（`replay.ts`）：**默认忽略**新事件（模型可见 ⟺ 已记录，但反过来不成立）；
4. 加测试：结构、投影不受影响、指标/归档能读；
5. 更新本文档与 handover。

## 3. Manifest 契约（`contractVersion`）

**管什么**：manifest 的必填字段集合与装配语义（`requires`/`prompt`/`tools`/`permission` 必须完整声明；能力协商按 kind 匹配；装配失败不留日志）。

**规则**：
1. `contractVersion` 是 manifest 的**必填**字段；不等于当前支持值（现在只有 `1`）→ **装配期失败**（`RecipeManifestError: unsupported manifest.contractVersion`），不是运行时才炸；
2. **什么情况必须升**：必填字段增删、能力 kind 的语义变化、协商规则变化、装配快照形状变化；
3. **什么情况不升**：新增可选字段（例如 `description`、`budget`、`evaluation`）；
4. 升版时：旧 recipe 可以继续声明旧版（读取方按版本分支），但**新字段只在声明新版时生效**；不确定时按"升版 + 保留旧分支"处理，别赌；
5. 装配快照记录了 `recipe.contractVersion`，因此**恢复时能发现契约不一致**（D3 的装配身份校验）。

## 4. 公开 API（包）

### 哪些是"公开面"
只有两个包目前承载对外契约：

| 包 | 谁用 | 入口 |
|---|---|---|
| `@cubus/sdk` | 做产品 app 的人（会话运行时、指标、归档） | `src/index.ts` 的**显式导出清单** |
| `@cubus/agent-recipe` | 写 recipe / host 的人（声明与协商的类型与函数） | 同上 |

**其余包都是内部实现**：可以随便重构，不承诺兼容。外部使用者只能按包名导入；`@cubus/xxx/src/yyy.ts` 这种内部路径**不是 API**。

### 规则
1. **显式导出，不用 `export *`**：新公开名字必须写进清单（评审时看得见）；由 `architecture-guard` 强制；
2. **additive（可直接进 minor）**：新增函数/类型、新增可选字段、放宽入参；
3. **破坏性（要升 minor 并写迁移）**：改名、删除、收窄类型、改变已有函数语义或返回形状、改变默认值；
4. **废弃流程**：先标记（注释 + 文档）→ 保留至少一个 minor → 再删除；
5. **版本号现状**：所有包仍是 `0.0.0`（未发布）。**第一次对外发布前**再定 1.0 的时机与语义化承诺，别提前承诺。

## 5. 规则怎么被强制（不靠记性）

| 规则 | 强制手段 |
|---|---|
| 公开面不出现 `export *` | `architecture-guard`：读 `@cubus/sdk` 与 `@cubus/agent-recipe` 的入口文件，逐行检查 |
| 公开面足够建产品 | `@cubus/sdk` 的 `public-api.test.ts`：**只用包名导入**，跑通"建产品 → 运行 → 回放 → 指标 → 归档"，并自检源码里没有相对导入 |
| 依赖方向（内核不依赖产品/应用，产品不依赖应用） | `architecture-guard`：读所有包的 `dependencies` 计算层次；已知例外显式列出（带理由） |
| 包间不靠相对路径穿透 | `architecture-guard`：扫源码里的 `../../../` 跨包导入 |
| 日志格式版本读写规则 | `@cubus/session` 的测试（缺失=v1、过新=拒绝）+ 归档导入的版本校验测试 |
| manifest 契约完整性 | `validateManifest` + B4 的声明校验测试（缺字段/未知版本装配期失败） |
| 归档版本与完整性 | `archive.test.ts`（未知版本拒绝、sha256 校验、白名单文件） |

## 6. 不做的事（明确划掉）

- **不做跨版本自动迁移工具**：过新的日志一律拒绝，由人决定升级工具还是保留旧数据；
- **不为未发布的包承诺语义化版本**：0.0.0 期间随便改，但**公开面清单的增减要显式**；
- **不做双写/双读兼容层**：需要兼容时按 `contractVersion` 分支，而不是让新旧格式同时存在于一份日志里。
