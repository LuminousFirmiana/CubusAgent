import { join } from 'node:path'
import type { GitChangeReport } from '@cubus/git'
import type { SessionEvent } from '@cubus/session'
import type { EvalGateLevel } from './suites.ts'

/**
 * 行为指纹（D4；设计见 docs/design/eval-suite-and-resume.md §4）。
 *
 * golden **不是原始日志**（含 id、时间、模型措辞，天然不可复现），而是从日志 + 工作区
 * 算出来的行为指纹：判分、事件类型序列、工具序列、工作区文件集。
 *
 * 刻意不进指纹的东西：工具参数与输出文本、助手回复文本、行数统计、耗时、会话 id、时间戳
 * —— 把它们放进门禁只会让门禁变成随机红灯。
 */

export type FingerprintFileKind = 'created' | 'modified' | 'deleted' | 'restored'

export interface FingerprintFile {
  readonly path: string
  readonly kind: FingerprintFileKind
}

export interface BehaviorFingerprint {
  readonly judge: 'pass' | 'fail'
  /** 事件类型序列；工具事件带名字与结果，便于人复盘（**不参与判定**，见 §4.2）。 */
  readonly events: readonly string[]
  /** 工具名调用序列；guardrails 档位下只记录不判定（strict/subsequence 参与判定）。 */
  readonly tools: readonly string[]
  /** 工作区文件集：来自 A1 的只读 Git 报告（判定用）。 */
  readonly files: readonly FingerprintFile[]
}

/**
 * 不参与指纹的事件：
 * - assistant/chunk：流式碎片，粒度取决于 provider（放进指纹就是随机红灯）；
 * - session/mount：装配快照，另有身份校验（D1 §5.3）。
 */
const IGNORED_EVENT_TYPES = new Set(['assistant/chunk', 'session/mount'])

export function behaviorFingerprint(options: {
  readonly events: readonly SessionEvent[]
  readonly judge: 'pass' | 'fail'
  readonly changes?: GitChangeReport
}): BehaviorFingerprint {
  const toolNames = new Map<string, string>()
  for (const event of options.events) {
    if (event.type === 'tool/call') toolNames.set(event.id, event.name)
  }

  const events: string[] = []
  const tools: string[] = []
  for (const event of options.events) {
    if (IGNORED_EVENT_TYPES.has(event.type)) continue
    if (event.type === 'tool/call') {
      tools.push(event.name)
      events.push('tool/call:' + event.name)
      continue
    }
    if (event.type === 'tool/result') {
      const name = toolNames.get(event.id) ?? 'unknown'
      events.push('tool/result:' + name + ':' + (event.ok ? 'ok' : 'failed'))
      continue
    }
    events.push(event.type)
  }

  const files = (options.changes?.isRepository === true ? options.changes.changed : [])
    .map(file => ({ path: file.path, kind: file.kind as FingerprintFileKind }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  return { judge: options.judge, events, tools, files }
}

/** 调用预算宽限：actual 的工具调用数不得超过 golden + 这个值（挡住退化成暴力重试）。 */
export const FINGERPRINT_CALL_BUDGET_SLACK = 3

export interface FingerprintComparison {
  readonly ok: boolean
  readonly differences: readonly string[]
}

function describeFiles(files: readonly FingerprintFile[]): string[] {
  return files.map(file => file.path + ':' + file.kind)
}

/** 是否把 golden 的工具序列按序包含（允许夹带其它工具）。 */
function coversSubsequence(golden: readonly string[], actual: readonly string[]): boolean {
  let index = 0
  for (const tool of actual) {
    if (tool === golden[index]) index += 1
  }
  return index >= golden.length
}

/**
 * 门禁判定（ADR §4.2 四条规则，全过才算通过）：
 * 1. judge 必须仍然是 pass；
 * 2. 文件集（路径 + 变更类别）相等——多改一个文件是越界，少改是没做完；
 * 3. 工具序列：**只有 strict / subsequence 档位才比较**（默认 guardrails 不比 —— 工具身份是实现选择，见 ADR §4.4）；
 * 4. 调用预算不超过 golden + 3。
 */
export function compareFingerprints(
  golden: BehaviorFingerprint,
  actual: BehaviorFingerprint,
  gate: EvalGateLevel = 'guardrails',
): FingerprintComparison {
  // gate = 'guardrails' 时跳过工具序列规则（判分 / 文件集 / 调用预算仍然生效）
  const differences: string[] = []

  if (actual.judge !== 'pass') {
    differences.push('judge: expected pass, got ' + actual.judge)
  }

  const goldenFiles = describeFiles(golden.files)
  const actualFiles = describeFiles(actual.files)
  if (goldenFiles.join(' | ') !== actualFiles.join(' | ')) {
    const missing = goldenFiles.filter(entry => !actualFiles.includes(entry))
    const extra = actualFiles.filter(entry => !goldenFiles.includes(entry))
    differences.push(
      'files: missing [' + missing.join(', ') + '] extra [' + extra.join(', ') + ']',
    )
  }

  if (gate === 'strict') {
    if (golden.tools.join(',') !== actual.tools.join(',')) {
      differences.push(
        'tools (strict): expected [' + golden.tools.join(', ') + '] got [' + actual.tools.join(', ') + ']',
      )
    }
  } else if (gate === 'subsequence') {
    if (!coversSubsequence(golden.tools, actual.tools)) {
      differences.push(
        'tools (subsequence): golden [' + golden.tools.join(', ') +
        '] is not covered in order by [' + actual.tools.join(', ') + ']',
      )
    }
  }

  if (actual.tools.length > golden.tools.length + FINGERPRINT_CALL_BUDGET_SLACK) {
    differences.push(
      'call budget: ' + String(actual.tools.length) + ' calls exceeds golden ' +
      String(golden.tools.length) + ' + ' + String(FINGERPRINT_CALL_BUDGET_SLACK),
    )
  }

  return { ok: differences.length === 0, differences }
}

/** golden 指纹文件随夹具提交（小、可审）；原始日志不进 git（体积），作为 CI artifact。 */
export function goldenPathFor(fixtureDir: string): string {
  return join(fixtureDir, 'golden.json')
}

export function renderGolden(fingerprint: BehaviorFingerprint): string {
  return JSON.stringify(fingerprint, null, 2) + '\n'
}

/** 解析 golden 文件（坏文件要立刻说清楚是哪一份，而不是让门禁静默通过）。 */
export function parseGolden(raw: string, source: string): BehaviorFingerprint {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(source + ': golden is not valid JSON: ' + String(error))
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(source + ': golden must be a JSON object')
  }
  const record = parsed as Record<string, unknown>
  const judge = record['judge']
  if (judge !== 'pass' && judge !== 'fail') {
    throw new Error(source + ': golden.judge must be pass or fail')
  }
  const tools = record['tools']
  const events = record['events']
  const files = record['files']
  if (!Array.isArray(tools) || !tools.every(tool => typeof tool === 'string')) {
    throw new Error(source + ': golden.tools must be an array of strings')
  }
  if (!Array.isArray(events) || !events.every(event => typeof event === 'string')) {
    throw new Error(source + ': golden.events must be an array of strings')
  }
  if (!Array.isArray(files)) {
    throw new Error(source + ': golden.files must be an array')
  }
  return {
    judge,
    events: events as string[],
    tools: tools as string[],
    files: (files as FingerprintFile[]).map(file => ({ path: file.path, kind: file.kind })),
  }
}

/** 人类可读的对比报告（golden 重算命令打印它，供人审 diff）。 */
export function renderFingerprintComparison(
  golden: BehaviorFingerprint,
  actual: BehaviorFingerprint,
  comparison: FingerprintComparison,
): string {
  const lines: string[] = []
  lines.push(comparison.ok ? 'gate: PASS' : 'gate: FAIL')
  for (const difference of comparison.differences) lines.push('  - ' + difference)
  lines.push('  tools  golden: [' + golden.tools.join(', ') + ']')
  lines.push('  tools  actual: [' + actual.tools.join(', ') + ']')
  lines.push('  files  golden: [' + describeFiles(golden.files).join(', ') + ']')
  lines.push('  files  actual: [' + describeFiles(actual.files).join(', ') + ']')
  return lines.join('\n')
}
