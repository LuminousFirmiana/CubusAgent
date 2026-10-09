# 沙箱 seam 与凭据最小暴露

> 状态：Accepted（2026-10-09）。§12 记录了四项已确认的决定。这是 roadmap C 阶段（C1–C6，P5 共享安全层）的设计依据。
> 前置：[recipe-capabilities.md](recipe-capabilities.md)（能力协商，Accepted）。

## 1. 背景：现在的安全姿态是"知情确认"，不是"强制边界"

| 现状 | 事实 | 缺口 |
|---|---|---|
| 受信工作区闸门 | CLI 强制 `--trust-workspace`，并打印"Local bash is not sandboxed" | 它是**确认**，不是边界：确认之后命令就在宿主上跑 |
| 逐工具审批（S4.2） | ask/allow/deny，默认 ask，非交互默认拒绝 | 审批是给人看的；人会点"允许"，而且它不限制系统权限 |
| 子进程凭据清洗（S2.3a） | 按名字正则过滤 KEY/SECRET/TOKEN/PASSWORD 环境变量 | 尽力而为：换个名字（`MY_API`）就漏；也没有白名单语义 |
| 工具边界 | fs 钉在 workspace（拒绝 `..` 与绝对路径） | 只管 read_file/write_file/edit_file；bash 不受此限 |
| 缺少 | 执行隔离、网络边界、资源上限、凭据白名单、预算 | 声明 ④ 的四件事全部在这里 |

真实攻击面：Coding Agent 在陌生仓库里执行 `npm test`，等于执行该仓库的任意代码（`postinstall`、构建脚本、测试夹具）。因此"人确认过"不足以成为安全边界。

## 2. 决策摘要

1. **沙箱是能力，不是分支**：`sandbox` 是既有闭集里的一种 kind；Host 提供 `local-unconfined` 或 `docker`，recipe 声明它需要什么保护。
2. **`unconfined` 是显式特性**：本地 provider 只声明 `unconfined`，因此"需要 fs-isolation 的 recipe + 本地 Host"在**装配期就失败**（能力子集匹配不成立），而不是静默降级——这是本设计最重要的一条。
3. **叠加而非替换**：`sandbox` 描述并强制边界，`fs`/`subprocess` 描述在这层边界内怎么读写与执行；三者在同一个 Host 内必须自洽（Docker Host 的 fs/subprocess 实现本身走容器）。
4. **凭据是引用**：`credentials` 能力按名字发放引用，明文只在 Host 内部，注入发生在**执行边界**（容器 env / 临时文件），有租约与回收。
5. **预算与并发不进 Loop**：预算 = 监听 step/工具事件的 policy 插件（超限 → `loop.cancel()`）；并发 = Runtime 层队列。
6. **审批 ≠ 沙箱**：一个是人（可被说服、会疲劳），一个是机器（每次都在、不给例外）。
7. **诚实性**：无隔离必须在三处可见 —— CLI 启动输出、`session/mount` 快照的 capabilities、`--help` 文案。
8. **默认保留「本地无隔离」档**（已确认）：本地 Host 提供 `local-unconfined`；无人值守 / 陌生仓库档由 recipe 声明 `sandbox[fs-isolation]`，在本地装配期失败。
9. **网络 v1 只有 `--network none`**（已确认）：出口白名单是 C4 的第二小步，先把「边界默认关闭」钉死。

## 3. 威胁模型（先划边界，再谈防护）

**保护对象**：工作区之外的宿主文件系统；宿主凭据（环境变量、`.env`、SSH、云凭据）；宿主网络与内网可达面；宿主资源（CPU/内存/磁盘/进程数）。

**攻击者**：工作区里的代码与它诱导出的命令（恶意仓库、被 prompt injection 操纵的模型输出）。**不是**宿主用户本人。

**明确不防**：宿主上其它高权限进程；内核漏洞；容器逃逸 0-day；用户主动把凭据粘进任务描述。这些写进文档是为了不给出虚假保证。

## 4. 能力形状（v1）

`sandbox` 的 features（每个都是可验证的断言，不是形容词）：

| feature | 含义 | 判定方式（C3/C4 的测试） |
|---|---|---|
| `unconfined` | **显式**声明"没有隔离" | 只由本地 provider 声明；需要隔离的 recipe 不会匹配它 |
| `fs-isolation` | 工作区之外不可见/不可写 | 容器内读 `/etc/shadow`、写工作区外路径失败 |
| `network-deny` | 无网络 | 容器内 `curl` 超时/失败（`--network none`） |
| `resource-limits` | CPU/内存/PID/磁盘上限 | 内存炸弹被 OOM 杀死、fork 炸弹被 pids 上限拒绝 |
| `pid-isolation` | 进程与宿主隔离 | 容器内看不到宿主进程（独立 PID namespace） |

三个 offering：

```ts
// 本地：诚实声明自己无隔离
{ kind: 'sandbox', provider: 'local-unconfined', features: ['unconfined'] }
// Docker：会话级容器
{ kind: 'sandbox', provider: 'docker', features: ['fs-isolation', 'network-deny', 'resource-limits', 'pid-isolation'] }
```

recipe 侧（示例）：

```ts
// 无人值守档：必须有隔离，本地 Host 装配期直接失败
{ kind: 'sandbox', features: ['fs-isolation', 'network-deny'] }
// 交互审阅档：只要有文件隔离，可以在本地跑（approval 兜底）
{ kind: 'sandbox', features: ['fs-isolation'] }
```

匹配是子集判断（B2 已实现）：`unconfined` **不包含** `fs-isolation`，所以第二个示例在本地 Host 上也会失败；要跑本地必须显式降级——这是产品决策，不是默认行为。

## 5. Docker provider 契约（C4 实现）

- **粒度**：每个会话一个容器，生命周期跟随会话装配/卸载；工作区以 bind mount 挂进容器（读写）。
- **路径**：宿主工作区映射到容器内固定路径（`/workspace`），`ctx.workspaceDir` 在容器化 Host 下报容器内路径（recipe 无需知道宿主路径）。
- **网络**：默认 `--network none`；需要装依赖的场景走显式白名单（HTTP 代理 + 允许域名），并把实际策略写进快照。**v1 只做 `none`**（见 §12 决定 2）。
- **资源**：`--memory`、`--cpus`、`--pids-limit`；rootfs 只读 + 工作区与 `/tmp` 可写（tmpfs）。
- **权限**：非 root 用户；`--cap-drop ALL`；`--security-opt no-new-privileges`；**不挂 docker.sock**。
- **fs/subprocess 实现**：`DockerFs`（`docker exec` 读写或 `docker cp`）与 `DockerSubprocess`（`docker exec`；取消 = 结束 exec 并杀容器内进程组）。
- **凭据**：只以白名单方式注入容器（默认零宿主 env），见 §6。
- **镜像**：pin 到 **digest**（不是 tag），并把 digest 写进快照；镜像来源见 §12 决定 3。
- **结束**：容器销毁（`docker rm -f`），工作区保留；销毁失败必须报错而不是静默留下容器。
- **快照**：`capabilities` 里记录 provider 名与 features；容器细节（镜像 digest、网络策略、资源上限）作为 sandbox offering 的附加描述进入快照。

## 6. 凭据模型

```ts
/** 引用：名字 + 形态；不含明文 */
interface CredentialReference { name: string; kind: 'env' | 'file' }
/** 租约：只在使用边界内有效，用完回收 */
interface CredentialLease { readonly reference: CredentialReference; readonly value: string; release(): Promise<void> }
interface CredentialsProvider {
  /** features 用名字空间声明（如 'deepseek'、'github'），与 requirements 子集匹配 */
  issue(reference: CredentialReference): Promise<CredentialLease>
}
```

铁律：

1. 明文**永不**进会话日志、永不进装配快照、永不进工具结果；
2. 工具与命令只拿引用或"已注入的执行环境"，不拿明文；
3. 注入最小化：一次执行只注入它需要的引用，执行结束即回收；
4. 目录级白名单：容器内默认**零宿主 env**（本地 provider 现在是名字正则黑名单，Docker provider 必须是白名单）。

拒绝测试（C3 的验收形态）：把假 key 放进宿主 env → 断言（a）容器内 `env` 看不到它；（b）会话日志全文搜索不到明文；（c）快照 config 里只有引用名。

## 7. 资源治理（预算与并发）

- **预算**（C5）：policy 插件累计"步数 / 工具调用数 / 墙钟时长"，超限 → `loop.cancel()` 并让日志完整结算（复用 S4.3b 的取消语义）。v1 **不依赖 token 计费**：日志目前没有 usage 字段，加 usage 属词汇变更，与 D1 一起讨论（§12 决定 4）。
- **有界并发**（C6）：Runtime 层队列（app 级）：全局并发上限 + 排队 + 超时；会话内串行已有（S2.3a），Host 额外限制容器数量。
- 两者都**不进 Loop**：Loop 只认识 `cancel()` 与已结算的 turn。

## 8. 五种能力的职责边界

| 能力 | 回答的问题 | 强制方式 |
|---|---|---|
| `approval` | "这一步该不该做？" | 人/静态策略，在执行前询问 |
| `sandbox` | "能做的最坏情况是什么？" | 宿主内核（namespace/cgroup）强制 |
| `fs` | "怎么读文件？" | 路径钉在 workspace（越界拒绝） |
| `subprocess` | "怎么跑命令？" | 进程组 + 超时 + 输出上限 + 取消 |
| `credentials` | "能用哪些凭据？" | 引用 + 最小注入 + 租约回收 |

## 9. 验收（C3–C6 的证据清单）

| 验收 | 证据形态 |
|---|---|
| 越界写被拒 | 容器内写 `/etc/x`、`/workspace/../x` 失败；宿主工作区外文件不可见 |
| 网络默认关 | `--network none` 下 `curl https://example.com` 失败（退出码非 0） |
| 凭据不外泄 | §6 的三条拒绝测试 |
| 逃逸尝试被拒 | 容器内 `--privileged` 不可得、无 docker.sock、`no-new-privileges` 生效 |
| 资源上限生效 | 内存炸弹 OOM、fork 炸弹被 pids 限制拒绝 |
| 取消仍然彻底 | 容器内长命令取消后进程组结束（复用 S4.3b 形态） |
| **同 recipe 双 Host** | 需要 `fs-isolation` 的 recipe：本地 Host 装配期失败（缺 feature），Docker Host 成功；recipe 目录零 diff —— 这条补上 B4 遗留的 gap |
| 无隔离可见 | 本地 Host 下 CLI 输出与快照都标 `unconfined` |

## 10. 非目标

- 不防内核/容器逃逸 0-day，不做多租户强隔离（P7 之后再谈）；
- 不做 GPU、分布式调度、CRD/Operator（Kthena 只作设计输入）；
- 不做网络 DLP 全功能（v1 只有 `none`，白名单是下一小步）；
- 不把沙箱、预算、并发塞进 Loop；
- 不在本阶段加 session 事件类型与格式版本（usage、凭据审计事件留给 D1）。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Docker 在开发机/CI 不可用 | 分两层：契约测试用**假 sandbox provider**（无 Docker 也能跑，进 CI 必跑）；真实 Docker 测试在缺 Docker 时**显式 skip 并打印原因**（不静默通过） |
| 每会话一个容器的启动开销 | 会话级复用（一次装配一个容器）；预热/池化留给以后，先测量再优化 |
| 镜像供应链 | 只允许白名单镜像并 pin digest；digest 进快照 |
| 假安全（以为有隔离其实没有） | `unconfined` 显式特性 + 装配期失败 + CLI 与快照双重可见 |
| 凭据仍被工具参数带出 | 工具只拿引用；拒绝测试断言日志全文无明文 |

## 12. 已确认的决定（2026-10-09）

1. **默认姿态**：保留「本地无隔离」档。本地 Host 提供 sandbox[unconfined] 并如实标注；需要隔离的 recipe（无人值守 / 陌生仓库档）在本地**装配期失败**，不静默降级。理由：本地自有仓库、人就在旁边时，强制容器的成本高于收益；真正的风险场景由 recipe 声明强制。
2. **网络 v1**：只做 --network none。域名白名单是 C4 的第二小步。理由：出口是最容易被滥用的通道，先把「默认全关」变成可测事实。
3. **镜像来源**：只允许白名单镜像并 pin **digest**（默认官方 node:22-slim），digest 进快照；不做 --image 自由传参。理由：不让「沙箱是否安全」取决于使用者拉的镜像。
4. **预算 v1**：只做步数 / 工具调用数 / 墙钟时长（不改日志词汇）；usage 字段与格式版本一起放到 D1。理由：先装粗粒度刹车挡住「跑飞」，避免为费用统计两次修改宪法第一页。
