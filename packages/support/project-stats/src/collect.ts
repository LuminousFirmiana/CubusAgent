import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 项目规模的事实采集（S7.1）。
 *
 * 存在的理由只有一个：**文档里的数字不许手抄**。手抄的数字会在某次提交后悄悄过期，
 * 而"过期但看起来权威"的数字比没有数字更糟。所以每个数字都由一个可复现的采集器产出，
 * 并在 `docs/stats.md` 里写明它是怎么算出来的。
 */
export interface ProjectStats {
  /** 工作区里的包数（packages/组/包/package.json）。 */
  readonly packages: number
  /** 会话日志的事件类型数（SessionEvent 联合的成员）。 */
  readonly eventKinds: number
  /** 能力种数（CAPABILITY_KINDS 的长度）。 */
  readonly capabilityKinds: number
  /** 测试文件数（每个包 test 目录下的 .test.ts）。 */
  readonly testFiles: number
  /** 测试声明数（源码里 test( 与 it( 的个数）—— 近似值，权威数字是运行结果。 */
  readonly testDeclarations: number
  /** 真容器集成测试数（hosts/docker 的测试声明）。 */
  readonly containerTests: number
  /** 评测结果（存在才给）：来自 packages/evals/evals/evals-*.json。 */
  readonly evals: readonly { readonly name: string; readonly summary: string }[]
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 剥掉块注释与行注释（正则用字符串拼出来，免得源码里出现会提前结束注释的字符组合）。 */
export function stripComments(source: string): string {
  const block = new RegExp('/' + '\\*[\\s\\S]*?' + '\\*' + '/', 'g')
  return source.replace(block, '').replace(/\/\/[^\n]*/g, '')
}

/**
 * 数事件词汇表里的成员数（`SessionEvent` 联合）。
 *
 * 两个坑都踩过：
 * 1. **单行成员**（`| { type: 'step/start'; ... }`）与多行成员写法不同 —— 只看缩进的计数会漏掉它们；
 * 2. **注释里也会出现** `type: '...'` —— 不先剥注释就会多算。
 *
 * 所以规则是：截取该类型声明这一段 → 剥注释 → 数**不重复**的成员名。
 */
export function countUnionMembers(source: string, name = 'SessionEvent'): number {
  const marker = 'export type ' + name + ' ='
  const start = source.indexOf(marker)
  if (start < 0) return 0
  const rest = source.slice(start + marker.length)
  const nextExport = rest.indexOf('\nexport ')
  const body = nextExport < 0 ? rest : rest.slice(0, nextExport)
  return new Set([...stripComments(body).matchAll(/type: '([^']+)'/g)].map(match => match[1])).size
}

/** 数 CAPABILITY_KINDS 的长度：它是**封闭集合**，"这个运行时承认几种环境能力"值得写进文档。 */
export function countCapabilityKinds(source: string): number {
  const marker = 'export const CAPABILITY_KINDS'
  const start = source.indexOf(marker)
  if (start < 0) return 0
  const end = source.indexOf(']', start)
  if (end < 0) return 0
  return new Set([...source.slice(start, end).matchAll(/'([a-z-]+)'/g)].map(match => match[1])).size
}

/** 数源码里的测试声明（近似：vitest 的实际条数由运行时输出给出）。 */
export function countTestDeclarations(source: string): number {
  return (stripComments(source).match(/(^|\s)(test|it)\(/g) ?? []).length
}

function listDirs(root: string): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/** 采集：所有输入都来自仓库本身（源码 + 评测结果文件），没有外部状态。 */
export function collectProjectStats(repositoryRoot: string): ProjectStats {
  const packagesRoot = join(repositoryRoot, 'packages')
  let packages = 0
  let testFiles = 0
  let testDeclarations = 0
  let containerTests = 0
  for (const group of listDirs(packagesRoot)) {
    for (const name of listDirs(join(packagesRoot, group))) {
      const dir = join(packagesRoot, group, name)
      if (!existsSync(join(dir, 'package.json'))) continue
      packages += 1
      const testDir = join(dir, 'test')
      const files = existsSync(testDir) ? readdirSync(testDir).filter(file => file.endsWith('.test.ts')) : []
      testFiles += files.length
      let declarations = 0
      for (const file of files) declarations += countTestDeclarations(readFileSync(join(testDir, file), 'utf8'))
      testDeclarations += declarations
      if (group === 'hosts' && name === 'docker') containerTests += declarations
    }
  }

  // 词汇表文件不在（比如临时脚手架里跑）：退化成 0，而不是抛异常 ——
  // 采集器可以"什么都没采到"，但不该因为仓库形状不同就炸掉。
  const sessionTypesPath = join(packagesRoot, 'core', 'session', 'src', 'types.ts')
  const sessionTypes = existsSync(sessionTypesPath) ? readFileSync(sessionTypesPath, 'utf8') : ''

  const evals: { name: string; summary: string }[] = []
  const retention = readJson(join(packagesRoot, 'evals', 'evals', 'evals-retention.json'))
  if (retention !== undefined) {
    evals.push({
      name: '上下文信息保留',
      summary: '窗口 ' + String(retention['contextWindow']) + ' · 事实 ' + String(retention['facts']) +
        ' 条 · 压缩 ' + String(retention['compactions']) + ' 次 → **' + String(retention['retentionPercent']) + '%**',
    })
  }
  const recall = readJson(join(packagesRoot, 'evals', 'evals', 'evals-recall.json'))
  if (recall !== undefined) {
    evals.push({
      name: '跨会话召回',
      summary: '事实 ' + String(recall['facts']) + ' 条 + 临时状态 ' + String(recall['transient']) +
        ' 条 → 召回 **' + String(recall['recallRate']) + '%** · 克制 **' + String(recall['restraintRate']) +
        '%** · 按需检索 ' + String(recall['recallCalls']) + ' 次',
    })
  }

  const approvals = readJson(join(packagesRoot, 'evals', 'evals', 'evals-approvals.json'))
  if (approvals !== undefined) {
    const without = approvals['withoutRules'] as { toolCalls?: number; prompts?: number } | undefined
    const withRules = approvals['withRules'] as { toolCalls?: number; prompts?: number } | undefined
    evals.push({
      name: '审批打扰',
      summary: '同一任务 ' + String(withRules?.toolCalls ?? 0) + ' 次工具调用：无规则打扰 ' +
        String(without?.prompts ?? 0) + ' 次 → 有规则 ' + String(withRules?.prompts ?? 0) +
        ' 次（**下降 ' + String(approvals['promptReductionPercent']) + '%**）',
    })
  }

  return {
    packages,
    eventKinds: countUnionMembers(sessionTypes),
    capabilityKinds: countCapabilityKinds(sessionTypes),
    testFiles,
    testDeclarations,
    containerTests,
    evals,
  }
}