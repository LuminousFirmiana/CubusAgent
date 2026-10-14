import { createHash } from 'node:crypto'
import type { ToolApprovalDecision, ToolApprovalRequest, ToolApprovalService } from './service.ts'

/**
 * 一条权限规则（S5.1）。
 *
 * 设计取舍：规则**只做 allow/deny 的硬判定**，`ask` 交回档位（档位自带 prompter）。
 * 这样"规则"与"档位"职责不重叠：规则回答"这条调用我明确知道该怎么办吗"，
 * 档位回答"不知道的时候默认怎么处理、要不要问人"。
 */
export interface PermissionRule {
  /** 工具名：精确（`bash`）或通配（`*`、`read_*`）。 */
  readonly tool: string
  /** 参数匹配（可选）：对 `JSON.stringify(args)` 做包含/正则匹配，全部满足才算命中。 */
  readonly args?: {
    readonly contains?: readonly string[]
    readonly regex?: string
  }
  readonly decision: 'allow' | 'deny' | 'ask'
  /** 人读的理由：进拒绝信息，也让"为什么放行"在审计时说得清。 */
  readonly reason?: string
}

export interface PermissionRulesFile {
  readonly version: 1
  readonly rules: readonly PermissionRule[]
}

export class PermissionRulesError extends Error {
  readonly source: string

  constructor(source: string, message: string) {
    super(source + ': ' + message)
    this.name = 'PermissionRulesError'
    this.source = source
  }
}

/**
 * 严格解析规则文件：**拼错就报错，不静默忽略**。
 *
 * 权限配置是最不该"猜"的地方：把 `deny` 拼成 `denny` 却静默降级成默认行为，
 * 会让人以为禁掉了其实没有。所以任何未知字段、未知决策值都直接失败。
 */
export function parsePermissionRules(value: unknown, source = 'permissions.json'): PermissionRulesFile {
  if (typeof value !== 'object' || value === null) throw new PermissionRulesError(source, 'must be a JSON object')
  const record = value as Record<string, unknown>
  const version = record['version'] ?? 1
  if (version !== 1) throw new PermissionRulesError(source, 'unsupported version: ' + String(version))
  const rawRules = record['rules']
  if (!Array.isArray(rawRules)) throw new PermissionRulesError(source, '"rules" must be an array')
  const rules = rawRules.map((item, index) => parseRule(item, source, index))
  return { version: 1, rules }
}

function parseRule(value: unknown, source: string, index: number): PermissionRule {
  const at = 'rules[' + String(index) + ']'
  if (typeof value !== 'object' || value === null) throw new PermissionRulesError(source, at + ' must be an object')
  const record = value as Record<string, unknown>
  const tool = record['tool']
  if (typeof tool !== 'string' || tool.trim() === '') throw new PermissionRulesError(source, at + '.tool must be a non-empty string')
  const decision = record['decision']
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'ask') {
    throw new PermissionRulesError(source, at + '.decision must be allow, deny or ask (got ' + JSON.stringify(decision) + ')')
  }
  const reason = record['reason']
  if (reason !== undefined && typeof reason !== 'string') throw new PermissionRulesError(source, at + '.reason must be a string')
  const args = record['args']
  let parsedArgs: PermissionRule['args']
  if (args !== undefined) {
    if (typeof args !== 'object' || args === null) throw new PermissionRulesError(source, at + '.args must be an object')
    const argsRecord = args as Record<string, unknown>
    const contains = argsRecord['contains']
    if (contains !== undefined && (!Array.isArray(contains) || contains.some(entry => typeof entry !== 'string'))) {
      throw new PermissionRulesError(source, at + '.args.contains must be an array of strings')
    }
    const regex = argsRecord['regex']
    if (regex !== undefined) {
      if (typeof regex !== 'string') throw new PermissionRulesError(source, at + '.args.regex must be a string')
      try {
        new RegExp(regex)
      } catch (error) {
        throw new PermissionRulesError(source, at + '.args.regex is not a valid regex: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    parsedArgs = {
      ...(contains === undefined ? {} : { contains: contains as string[] }),
      ...(regex === undefined ? {} : { regex }),
    }
  }
  return {
    tool,
    decision,
    ...(reason === undefined ? {} : { reason }),
    ...(parsedArgs === undefined ? {} : { args: parsedArgs }),
  }
}

/** 工具名匹配：`*` 与 `?` 通配（锚定整名，避免 `read` 意外匹配 `read_file`）。 */
export function matchesToolName(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true
  const escaped = pattern.replace(/[.+^$()|[\]\\{}]/g, character => '\\' + character)
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return regex.test(toolName)
}

/** 参数匹配：对 JSON 文本做包含与正则（都给了就都要满足）。 */
export function matchesArgs(rule: PermissionRule, args: unknown): boolean {
  if (rule.args === undefined) return true
  let text: string
  try {
    text = JSON.stringify(args) ?? ''
  } catch {
    return false
  }
  if (rule.args.contains !== undefined && !rule.args.contains.every(fragment => text.includes(fragment))) return false
  if (rule.args.regex !== undefined && !new RegExp(rule.args.regex).test(text)) return false
  return true
}

export interface RuleMatch {
  readonly rule: PermissionRule
  readonly index: number
}

/**
 * 找第一条命中的规则：**文件顺序即优先级，首个命中生效**（与 .gitignore 同一心智模型）。
 *
 * 不做"deny 优先"的隐式排序：那会让"我把 deny 写在后面"变成陷阱。想让它优先，就写在前面。
 */
export function matchPermissionRule(rules: readonly PermissionRule[], request: { toolName: string; args: unknown }): RuleMatch | undefined {
  for (const [index, rule] of rules.entries()) {
    if (!matchesToolName(rule.tool, request.toolName)) continue
    if (!matchesArgs(rule, request.args)) continue
    return { rule, index }
  }
  return undefined
}

/** 规则文件的指纹：进装配快照，这样"当时生效的是哪一份规则"可追溯。 */
export function permissionRulesFingerprint(file: PermissionRulesFile): string {
  return createHash('sha256').update(JSON.stringify(file)).digest('hex')
}

export interface RulesApprovalOptions {
  readonly rules: readonly PermissionRule[]
  /** 规则没命中时交给它（档位 + prompter 都在这里）。 */
  readonly fallback: ToolApprovalService
}

/**
 * 规则 + 兜底档位组成的审批服务。
 *
 * 规则命中 `allow`/`deny` 就直接给结论（**不打扰人**）；命中 `ask` 或没命中都交给兜底 ——
 * 所以"规则"是**减少打扰**的手段，而不是另一套权限系统。
 */
export function createRulesToolApproval(options: RulesApprovalOptions): ToolApprovalService {
  return {
    decide(request: ToolApprovalRequest, context): Promise<ToolApprovalDecision> | ToolApprovalDecision {
      const match = matchPermissionRule(options.rules, { toolName: request.toolName, args: request.args })
      if (match === undefined || match.rule.decision === 'ask') return options.fallback.decide(request, context)
      const reason = match.rule.reason ?? ('matched rule #' + String(match.index + 1) + ' (' + match.rule.tool + ')')
      return { outcome: match.rule.decision, reason }
    },
  }
}

export interface LoadPermissionRulesOptions {
  /** 读文件的注入点（app 传 node:fs；测试传假的）。 */
  readonly readText: (path: string) => Promise<string>
  /** 规则文件绝对路径（app 决定放哪；约定是工作区下的 .cubus/permissions.json）。 */
  readonly path: string
}

export interface LoadedPermissionRules {
  /** 没找到文件时给空规则集（权限规则本来就是可选的）。 */
  readonly file: PermissionRulesFile
  /** 文件不存在：区别于"存在但解析失败"（后者抛错，绝不静默降级）。 */
  readonly missing: boolean
  readonly sha256: string
}

/** 规则文件约定路径：工作区相对路径（app 拼绝对路径）。 */
export const PERMISSION_RULES_RELATIVE_PATH = '.cubus/permissions.json'

/**
 * 读并解析规则文件。**"不存在"与"写坏了"区别对待**：
 * 没配置 = 空规则（正常）；配置了但解析失败 = 抛错（绝不静默降级成"没有规则"）。
 */
export async function loadPermissionRules(options: LoadPermissionRulesOptions): Promise<LoadedPermissionRules> {
  let content: string
  try {
    content = await options.readText(options.path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if ((error as { code?: string }).code === 'ENOENT' || /ENOENT|no such file|not found/i.test(message)) {
      return { file: { version: 1, rules: [] }, missing: true, sha256: permissionRulesFingerprint({ version: 1, rules: [] }) }
    }
    throw error
  }
  const parsed = JSON.parse(content) as unknown
  const file = parsePermissionRules(parsed, options.path)
  return { file, missing: false, sha256: permissionRulesFingerprint(file) }
}