import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { findCycles, findDependencyViolations, loadWorkspacePackages } from '../src/graph.ts'
import type { WorkspacePackage } from '../src/graph.ts'

/** 仓库根：本文件位于 packages/support/architecture-guard/test。 */
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

test('dependencies only point downwards: no kernel -> product, no product -> app', async () => {
  const packages = await loadWorkspacePackages(repositoryRoot)
  expect(packages.length).toBeGreaterThan(20)

  const violations = findDependencyViolations(packages)
  expect(violations, 'dependency direction violations:\n' + violations.join('\n')).toEqual([])

  // 关键的那几条单独钉一次（坏了能立刻看出是哪条纪律被破坏）
  const kernel = packages.filter(entry => entry.layer === 'kernel')
  expect(kernel.length).toBeGreaterThan(0)
  for (const entry of kernel) {
    expect(entry.dependencies.filter(name => name.startsWith('@cubus/')), entry.name)
      .toEqual(expect.arrayContaining([]))
    expect(entry.dependencies.some(name => name === '@cubus/sdk'), entry.name + ' must not depend on the facade').toBe(false)
  }
})

test('the workspace has no package-level dependency cycles', async () => {
  const packages = await loadWorkspacePackages(repositoryRoot)
  const cycles = findCycles(packages)
  expect(cycles, 'cycles:\n' + cycles.map(cycle => cycle.join(' -> ')).join('\n')).toEqual([])
})

test('the guard itself notices a violation (the check is not vacuous)', () => {
  const packages: WorkspacePackage[] = [
    { name: '@cubus/session', dir: '/x', layer: 'kernel', dependencies: ['@cubus/recipe-coding-agent'] },
    { name: '@cubus/recipe-coding-agent', dir: '/y', layer: 'product', dependencies: [] },
  ]
  expect(findDependencyViolations(packages)).toEqual([
    '@cubus/session (kernel) -> @cubus/recipe-coding-agent (product)',
  ])
  const cyclic: WorkspacePackage[] = [
    { name: 'a', dir: '/a', layer: 'kernel', dependencies: ['b'] },
    { name: 'b', dir: '/b', layer: 'kernel', dependencies: ['a'] },
  ]
  expect(findCycles(cyclic)).toEqual([['a', 'b', 'a']])
})

test('public surfaces are curated: no export * in the packages outsiders build against', async () => {
  const publicEntrypoints = [
    join(repositoryRoot, 'packages', 'sdk', 'sdk', 'src', 'index.ts'),
    join(repositoryRoot, 'packages', 'core', 'agent-recipe', 'src', 'index.ts'),
  ]
  for (const path of publicEntrypoints) {
    const source = await readFile(path, 'utf8')
    // 只看语句、不看注释：注释里写"不要 export *"不该被判违规
    const starExports = source.split('\n').map(line => line.trim()).filter(line => line.startsWith('export *'))
    expect(starExports, path + ' must not use export *').toEqual([])
    // 显式导出才对：至少有若干 export 语句
    expect(source.split('\n').filter(line => line.startsWith('export')).length).toBeGreaterThan(2)
  }
})

test('no source file reaches outside its own package with a relative path', async () => {
  const packages = await loadWorkspacePackages(repositoryRoot)
  const offenders: string[] = []
  const { readdir } = await import('node:fs/promises')
  async function walk(dir: string): Promise<void> {
    // 有些包（例如 smoke）没有 src 目录：跳过而不是失败
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const source = await readFile(path, 'utf8')
      // ../../../ 这种跨包相对导入：包间必须用包名
      for (const match of source.matchAll(/from '(\.\.\/\.\.\/\.\.\/[^']*)'/g)) {
        offenders.push(path.replace(repositoryRoot + '/', '') + ' -> ' + match[1])
      }
    }
  }
  for (const entry of packages) await walk(join(entry.dir, 'src'))
  expect(offenders, 'cross-package relative imports:\n' + offenders.join('\n')).toEqual([])
})
