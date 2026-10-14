/**
 * 技能有效性评测（S4b.4）—— "有技能 / 无技能"两档对比，判分看**产物**，不看模型自评。
 *
 *   pnpm run eval:skills
 *
 * 脚手架里放了一套**只有技能才知道的**发版约定（版本号方案、必须先跑 preflight、
 * CHANGELOG 条目格式）。两档跑同一个任务：
 *   A. 工作区里**没有**技能 → 模型只能猜；
 *   B. 工作区里**有**技能 → 索引里一行，模型按需读正文。
 *
 * 判分（跑完检查工作区，确定性的三条）：
 *   ① 跑过 preflight（生成了 .preflight-ok）
 *   ② VERSION 按技能的方案升到 v1.5.0（技能写明是 minor 提升）
 *   ③ CHANGELOG.md 里有 "## v1.5.0" 条目
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalAgentHost } from '@cubus/host-local'
import type { LlmAdapter } from '@cubus/llm'
import { cubusCodingAgentRecipe } from '@cubus/recipe-cubus-coding-agent'
import { SessionRuntime } from '@cubus/sdk'
import { loadSkills, nodeSkillIO, PROJECT_SKILLS_DIRNAME, SkillCatalog, withSkills } from '@cubus/skills'
import { createStaticToolApproval, withToolApprovalHost } from '@cubus/tool-approval'
import { createAdapterFactory, readSettings, repositoryRoot } from './model.ts'

const TASK = '请给这个仓库发一个版本（按仓库里的约定来）。做完用一句话汇报你做了什么。'

/** 只有技能才知道的约定：minor 提升 + 必须跑 preflight + CHANGELOG 条目格式。 */
const SKILL = [
  '---',
  'name: release',
  'description: 本仓库的发版流程（版本号方案、preflight、CHANGELOG 条目格式）',
  'when: 需要发版时',
  '---',
  '',
  '# 本仓库发版流程（必须按顺序）',
  '',
  '1. **先跑** \'bash scripts/preflight.sh\'，它会生成 .preflight-ok 标记文件；没跑过就不算发版。',
  '2. 版本号方案：提升 minor 并**加内部后缀**，格式 vX.Y.Z-internal。例如当前 v1.4.0，下一个版本是',
  '   **v1.5.0-internal**（不是 v1.5.0，也不是 v1.4.1）。这个后缀是硬性要求，别的写法都不算发版。',
  '3. 把 VERSION 文件写成新版本号。',
  '4. 在 CHANGELOG.md 顶部加一条：第一行 \'## vX.Y.Z-internal\'，下面跟一行 \'- 变化：…\'。',
  '',
].join('\n')

function makeWorkspace(withSkill: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'cubus-skills-'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  writeFileSync(join(root, 'VERSION'), 'v1.4.0\n', 'utf8')
  writeFileSync(join(root, 'CHANGELOG.md'), '# 变更记录\n\n## v1.4.0\n- 变化：初始版本\n', 'utf8')
  writeFileSync(join(root, 'scripts', 'preflight.sh'),
    '#!/bin/sh\ntouch .preflight-ok\necho preflight ok\n', 'utf8')
  if (withSkill) {
    mkdirSync(join(root, PROJECT_SKILLS_DIRNAME, 'release'), { recursive: true })
    writeFileSync(join(root, PROJECT_SKILLS_DIRNAME, 'release', 'SKILL.md'), SKILL, 'utf8')
  }
  return root
}

interface Score {
  readonly preflight: boolean
  readonly version: boolean
  readonly changelog: boolean
  readonly total: number
}

function score(workspace: string): Score {
  const preflight = existsSync(join(workspace, '.preflight-ok'))
  const version = existsSync(join(workspace, 'VERSION'))
    && readFileSync(join(workspace, 'VERSION'), 'utf8').trim() === 'v1.5.0-internal'
  const changelog = existsSync(join(workspace, 'CHANGELOG.md'))
    && readFileSync(join(workspace, 'CHANGELOG.md'), 'utf8').includes('## v1.5.0-internal')
  return { preflight, version, changelog, total: [preflight, version, changelog].filter(Boolean).length }
}

async function runArm(options: {
  readonly withSkill: boolean
  readonly adapterFactory: () => LlmAdapter
}): Promise<{ score: Score; toolCalls: number; steps: number; tokens: number }> {
  const workspace = makeWorkspace(options.withSkill)
  const io = nodeSkillIO()
  const roots = [{ source: 'project' as const, dir: join(workspace, PROJECT_SKILLS_DIRNAME) }]
  const loaded = await loadSkills({ io, roots })
  const catalog = new SkillCatalog({ skills: loaded.skills, bodies: loaded.bodies, roots, io })

  const runtime = new SessionRuntime({
    rootDir: join(workspace, '.sessions'),
    host: withToolApprovalHost(
      createLocalAgentHost({ adapterFactory: options.adapterFactory, workspaceDir: workspace }),
      createStaticToolApproval('allow', 'skills eval'),
    ),
    recipe: withSkills(cubusCodingAgentRecipe, { skills: loaded.skills, catalog }),
    recipeOptions: { skills: loaded.skills.map(skill => ({ name: skill.name, source: skill.source, path: skill.path, description: skill.description, sha256: skill.sha256, attachmentCount: skill.attachmentCount })) },
    permissionProfile: 'allow',
    retry: { maxAttempts: 2 },
  })
  const session = await runtime.create()
  const run = await runtime.run(session.id, TASK)
  const toolCalls = run.turnEvents.filter(event => event.type === 'tool/call').length
  const steps = run.turnEvents.filter(event => event.type === 'step/start').length
  const tokens = run.turnEvents.reduce(
    (sum, event) => sum + (event.type === 'assistant/message' ? event.usage?.totalTokens ?? 0 : 0),
    0,
  )
  const result = score(workspace)
  rmSync(join(workspace, '.sessions'), { recursive: true, force: true })
  return { score: result, toolCalls, steps, tokens }
}

const settings = await readSettings()
if (settings.apiKey === undefined) {
  console.error('DEEPSEEK_API_KEY is required (process environment or repository .env)')
  process.exit(2)
}
const adapterFactory = await createAdapterFactory(settings.apiKey, settings.model)

const withoutSkill = await runArm({ withSkill: false, adapterFactory })
const withSkillResult = await runArm({ withSkill: true, adapterFactory })

console.log('技能有效性评测（同一任务，两档对比；判分看产物）')
console.log('  模型 ' + settings.model)
for (const [label, result] of [['A 无技能', withoutSkill], ['B 有技能', withSkillResult]] as const) {
  console.log('  ' + label + '：得分 ' + String(result.score.total) + '/3' +
    '（preflight ' + (result.score.preflight ? '✓' : '✗') +
    ' · 版本 ' + (result.score.version ? '✓' : '✗') +
    ' · CHANGELOG ' + (result.score.changelog ? '✓' : '✗') + '）' +
    ' · 步 ' + String(result.steps) + ' · 工具 ' + String(result.toolCalls) + ' · token ' + String(result.tokens))
}

const record = {
  at: new Date().toISOString(),
  model: settings.model,
  withoutSkill: { score: withoutSkill.score.total, steps: withoutSkill.steps, toolCalls: withoutSkill.toolCalls, tokens: withoutSkill.tokens },
  withSkill: { score: withSkillResult.score.total, steps: withSkillResult.steps, toolCalls: withSkillResult.toolCalls, tokens: withSkillResult.tokens },
  checks: { preflight: '生成 .preflight-ok', version: 'VERSION == v1.5.0-internal', changelog: 'CHANGELOG 含 ## v1.5.0-internal' },
}
writeFileSync(join(repositoryRoot, 'packages', 'evals', 'evals', 'evals-skills.json'), JSON.stringify(record, null, 2) + '\n')
appendFileSync(
  join(repositoryRoot, 'packages', 'evals', 'evals', 'EVALS.md'),
  '\n### 技能有效性（S4b.4）\n\n' +
  '- ' + record.at + ' · ' + record.model + ' · 判分看产物（preflight / 版本号 / CHANGELOG 条目）\n' +
  '- 无技能：**' + String(withoutSkill.score.total) + '/3**（步 ' + String(withoutSkill.steps) + ' · 工具 ' + String(withoutSkill.toolCalls) + ' · token ' + String(withoutSkill.tokens) + '）\n' +
  '- 有技能：**' + String(withSkillResult.score.total) + '/3**（步 ' + String(withSkillResult.steps) + ' · 工具 ' + String(withSkillResult.toolCalls) + ' · token ' + String(withSkillResult.tokens) + '）\n',
)
console.log('结果已写入 packages/evals/evals/evals-skills.json 与 EVALS.md')
process.exit(0)