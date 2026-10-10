import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 仓库级守卫（P1）：把两条纪律变成**机器检查**，而不是靠人记得。
 *
 * 1. **依赖只能向下**：内核不依赖接缝，接缝不依赖产品，产品不依赖应用；SDK 是门面，
 *    它不依赖产品/应用。理由：A（产品）将来要能被替换，B（运行时/SDK）将来要能对外开放 ——
 *    一旦内核里出现"产品逻辑"或"应用接线"，两条路都会变贵。
 * 2. **公开面不许悄悄变宽**：@cubus/sdk 与 @cubus/agent-recipe 的入口只能用显式导出，
 *    不允许 export *（新名字必须显式加进清单，评审时看得见）。
 */

export type Layer = 'kernel' | 'seam' | 'provider' | 'policy' | 'sdk' | 'product' | 'app' | 'support'

export interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly layer: Layer
  /** 运行期依赖（dependencies），devDependencies 不算：测试可以用任何东西。 */
  readonly dependencies: readonly string[]
}

/**
 * 已知例外：**显式列出来**，而不是把规则放宽 —— 例外在评审时看得见，也能追踪它何时被消除。
 * 每条写清"为什么现在允许"。
 */
export const KNOWN_EXCEPTIONS: readonly { readonly edge: string; readonly reason: string }[] = [
  {
    edge: '@cubus/agent-recipe -> @cubus/budget',
    reason: '装配器挂载预算策略（C5 的设计决定）。若将来策略也走能力声明，这条应被消除。',
  },
]

const LAYER_BY_GROUP: Readonly<Record<string, Layer>> = {
  core: 'kernel',
  seams: 'seam',
  providers: 'provider',
  policies: 'policy',
  recipes: 'product',
  apps: 'app',
  support: 'support',
}

/**
 * 各层允许依赖的层（只列 dependencies；support 是测试与守卫，不参与约束）。
 *
 * 内核**可以**依赖接缝：接缝就是内核拥有的契约（循环调用 LlmAdapter 接口是设计，不是越界）。
 * 内核**不可以**依赖提供方/策略/门面/产品/应用。
 */
const ALLOWED: Readonly<Record<Layer, readonly Layer[]>> = {
  kernel: ['kernel', 'seam'],
  seam: ['kernel', 'seam'],
  provider: ['kernel', 'seam', 'provider'],
  policy: ['kernel', 'seam', 'policy'],
  sdk: ['kernel', 'seam', 'provider', 'policy', 'sdk'],
  product: ['kernel', 'seam', 'provider', 'policy', 'sdk', 'product'],
  app: ['kernel', 'seam', 'provider', 'policy', 'sdk', 'product', 'app'],
  support: ['kernel', 'seam', 'provider', 'policy', 'sdk', 'product', 'app', 'support'],
}

/** 读工作区里所有包的 name/dir/依赖；rootDir 是仓库根。 */
export async function loadWorkspacePackages(rootDir: string): Promise<WorkspacePackage[]> {
  const groups = (await readdir(join(rootDir, 'packages'), { withFileTypes: true })).filter(entry => entry.isDirectory())
  const packages: WorkspacePackage[] = []
  for (const group of groups) {
    const layer = LAYER_BY_GROUP[group.name]
    if (layer === undefined) continue
    const entries = (await readdir(join(rootDir, 'packages', group.name), { withFileTypes: true })).filter(entry => entry.isDirectory())
    for (const entry of entries) {
      const dir = join(rootDir, 'packages', group.name, entry.name)
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        name: string
        dependencies?: Record<string, string>
      }
      packages.push({
        name: manifest.name,
        dir,
        layer,
        dependencies: Object.keys(manifest.dependencies ?? {}),
      })
    }
  }
  packages.sort((left, right) => (left.name < right.name ? -1 : 1))
  return packages
}

/** 依赖方向违规（返回人类可读的说明，空数组 = 干净）。 */
export function findDependencyViolations(packages: readonly WorkspacePackage[]): string[] {
  const byName = new Map(packages.map(entry => [entry.name, entry]))
  const violations: string[] = []
  for (const entry of packages) {
    if (entry.layer === 'support') continue
    for (const dependency of entry.dependencies) {
      if (!dependency.startsWith('@cubus/')) continue
      const target = byName.get(dependency)
      if (target === undefined) continue
      if (!ALLOWED[entry.layer].includes(target.layer)) {
        const edge = entry.name + ' -> ' + target.name
        if (KNOWN_EXCEPTIONS.some(exception => exception.edge === edge)) continue
        violations.push(entry.name + ' (' + entry.layer + ') -> ' + target.name + ' (' + target.layer + ')')
      }
    }
  }
  return violations.sort()
}

/** 包级循环依赖（返回每个环的成员，空数组 = 无环）。 */
export function findCycles(packages: readonly WorkspacePackage[]): string[][] {
  const byName = new Map(packages.map(entry => [entry.name, entry]))
  const edges = new Map<string, string[]>()
  for (const entry of packages) {
    edges.set(entry.name, entry.dependencies.filter(name => byName.has(name)))
  }

  const cycles: string[][] = []
  const seen = new Set<string>()
  const stack: string[] = []
  const onStack = new Set<string>()

  const visit = (name: string): void => {
    if (onStack.has(name)) {
      cycles.push([...stack.slice(stack.indexOf(name)), name])
      return
    }
    if (seen.has(name)) return
    seen.add(name)
    stack.push(name)
    onStack.add(name)
    for (const next of edges.get(name) ?? []) visit(next)
    stack.pop()
    onStack.delete(name)
  }
  for (const entry of packages) visit(entry.name)
  return cycles
}
