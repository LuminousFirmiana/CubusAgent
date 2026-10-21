import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * 工作台配置文件（F1）：让"日常使用"不需要每次敲一长串参数。
 *
 * 优先级：**命令行 > 配置文件 > 内置默认**。
 * 解析是**严格**的：未知字段/类型错误一律报错并指出是哪个键 ——
 * 拼错的配置如果被静默忽略，用户会以为它生效了（比报错更糟）。
 */

export interface WorkbenchConfigFile {
  readonly workspace?: string
  readonly approval?: 'ask' | 'allow' | 'deny'
  readonly approvalTimeoutSeconds?: number
  readonly port?: number
  readonly sessionsDir?: string
  readonly maxAttempts?: number
  /** 仅在没有 DEEPSEEK_MODEL 环境变量时生效。 */
  readonly model?: string
  /**
   * MCP 服务器清单（S2.4）。完整校验在 @cubus/mcp 的 parseMcpServerConfigs 里做
   * （名字唯一、stdio 必须有 command、http 必须有 url……），这里只保证是个数组。
   */
  readonly mcpServers?: unknown
  /**
   * 上下文窗口（token）：只用于"工具定义全量给还是按需检索"的判定。
   * 缺省 128k（保守值，宁可早一点走按需）。
   */
  readonly contextWindow?: number
  /** 跨会话记忆文件（默认 ~/.cubus/memory/memory.jsonl）。 */
  readonly memoryPath?: string
  /** 沙箱档（S5.2）：unconfined（默认）或 seatbelt。 */
  readonly sandbox?: 'unconfined' | 'seatbelt' | 'docker'
}

export const CONFIG_ENV_VAR = 'CUBUS_CONFIG'

const KNOWN_KEYS: readonly string[] = [
  'workspace',
  'approval',
  'approvalTimeoutSeconds',
  'port',
  'sessionsDir',
  'maxAttempts',
  'model',
  'mcpServers',
  'contextWindow',
  'memoryPath',
  'sandbox',
]

/** 配置路径：--config > $CUBUS_CONFIG > $XDG_CONFIG_HOME/cubus/config.json > ~/.cubus/config.json */
export function configPathFrom(options: { flag?: string; env: NodeJS.ProcessEnv }): string {
  if (options.flag !== undefined) return resolve(options.flag)
  const fromEnv = options.env[CONFIG_ENV_VAR]
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv)
  const xdg = options.env['XDG_CONFIG_HOME']
  if (xdg !== undefined && xdg.trim() !== '') return join(resolve(xdg), 'cubus', 'config.json')
  const home = options.env['HOME'] ?? options.env['USERPROFILE'] ?? homedir()
  return join(resolve(home), '.cubus', 'config.json')
}

export function parseWorkbenchConfig(raw: string, source: string): WorkbenchConfigFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(source + ': not valid JSON: ' + String(error))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(source + ': expected a JSON object')
  }

  const record = parsed as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.includes(key)) {
      throw new Error(source + ': unknown key "' + key + '" (known keys: ' + KNOWN_KEYS.join(', ') + ')')
    }
  }

  const config: {
    workspace?: string
    approval?: 'ask' | 'allow' | 'deny'
    approvalTimeoutSeconds?: number
    port?: number
    sessionsDir?: string
    maxAttempts?: number
    model?: string
    mcpServers?: unknown
    contextWindow?: number
    memoryPath?: string
    sandbox?: 'unconfined' | 'seatbelt' | 'docker'
  } = {}

  const workspace = record['workspace']
  if (workspace !== undefined) {
    if (typeof workspace !== 'string' || workspace.trim() === '') {
      throw new Error(source + ': "workspace" must be a non-empty string')
    }
    config.workspace = workspace
  }

  const sessionsDir = record['sessionsDir']
  if (sessionsDir !== undefined) {
    if (typeof sessionsDir !== 'string' || sessionsDir.trim() === '') {
      throw new Error(source + ': "sessionsDir" must be a non-empty string')
    }
    config.sessionsDir = sessionsDir
  }

  const approval = record['approval']
  if (approval !== undefined) {
    if (approval !== 'ask' && approval !== 'allow' && approval !== 'deny') {
      throw new Error(source + ': "approval" must be one of ask, allow, deny')
    }
    config.approval = approval
  }

  const model = record['model']
  if (model !== undefined) {
    if (typeof model !== 'string' || model.trim() === '') {
      throw new Error(source + ': "model" must be a non-empty string')
    }
    config.model = model
  }

  const mcpServers = record['mcpServers']
  if (mcpServers !== undefined) {
    if (!Array.isArray(mcpServers)) {
      throw new Error(source + ': "mcpServers" must be an array of server objects')
    }
    config.mcpServers = mcpServers
  }

  const contextWindow = record['contextWindow']
  if (contextWindow !== undefined) {
    if (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow < 1_000) {
      throw new Error(source + ': "contextWindow" must be an integer of at least 1000 tokens')
    }
    config.contextWindow = contextWindow
  }
  const memoryPath = record['memoryPath']
  if (memoryPath !== undefined) {
    if (typeof memoryPath !== 'string' || memoryPath.trim() === '') {
      throw new Error(source + ': "memoryPath" must be a non-empty string')
    }
    config.memoryPath = memoryPath
  }
  const sandbox = record['sandbox']
  if (sandbox !== undefined) {
    if (sandbox !== 'unconfined' && sandbox !== 'seatbelt' && sandbox !== 'docker') {
      throw new Error(source + ': "sandbox" must be unconfined, seatbelt or docker')
    }
    config.sandbox = sandbox
  }

  for (const key of ['approvalTimeoutSeconds', 'maxAttempts'] as const) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(source + ': "' + key + '" must be a positive integer')
    }
    config[key] = value
  }

  const port = record['port']
  if (port !== undefined) {
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error(source + ': "port" must be an integer between 0 and 65535')
    }
    config.port = port
  }

  return config
}

/** 读配置；文件不存在返回 undefined（用默认值继续），其它错误直接抛。 */
export async function readWorkbenchConfig(
  path: string,
): Promise<{ config: WorkbenchConfigFile; path: string } | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return { config: parseWorkbenchConfig(raw, path), path }
}

export function renderWorkbenchConfigTemplate(workspace: string): string {
  return JSON.stringify(
    {
      workspace,
      approval: 'ask',
      approvalTimeoutSeconds: 120,
      port: 4173,
      maxAttempts: 3,
    },
    null,
    2,
  ) + '\n'
}

/** 写配置模板；已存在且没有 force 时拒绝（不覆盖用户的东西）。 */
export async function writeWorkbenchConfig(
  path: string,
  workspace: string,
  options: { force: boolean },
): Promise<'written' | 'exists'> {
  await mkdir(dirname(path), { recursive: true })
  if (!options.force) {
    const existing = await readFile(path, 'utf8').then(() => true, () => false)
    if (existing) return 'exists'
  }
  await writeFile(path, renderWorkbenchConfigTemplate(workspace), 'utf8')
  return 'written'
}