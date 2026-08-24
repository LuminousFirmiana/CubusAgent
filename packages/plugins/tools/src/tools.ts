import type { Tool } from '@cubus/agent-loop'
import type { FsProvider } from './fs.ts'
import type { SubprocessProvider } from './subprocess.ts'

/** 工具参数校验：从 wire/模型来的 args 是不可信输入。 */
function stringField(args: unknown, name: string): string {
  if (typeof args !== 'object' || args === null || !(name in args)) {
    throw new Error(`missing argument: ${name}`)
  }
  const value = (args as Record<string, unknown>)[name]
  if (typeof value !== 'string') {
    throw new Error(`argument ${name} must be a string`)
  }
  return value
}

export function createReadFileTool(fs: FsProvider): Tool {
  return {
    name: 'read_file',
    description: 'Read a text file under the workspace and return its content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root' },
      },
      required: ['path'],
    },
    async execute(args: unknown): Promise<string> {
      const path = stringField(args, 'path')
      const content = await fs.readText(path)
      return `# ${path}\n\n${content}`
    },
  }
}

export function createWriteFileTool(fs: FsProvider): Tool {
  return {
    name: 'write_file',
    description: 'Write a text file under the workspace (creates or overwrites).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root' },
        content: { type: 'string', description: 'full file content' },
      },
      required: ['path', 'content'],
    },
    async execute(args: unknown): Promise<string> {
      const path = stringField(args, 'path')
      const content = stringField(args, 'content')
      await fs.writeText(path, content)
      return `wrote ${content.length} chars to ${path}`
    },
  }
}

/**
 * 字符串替换式编辑：old_string 必须唯一出现，否则报错并给出出现次数，
 * 让模型带更多上下文重试（claude-code 同款语义）。
 */
export function createEditFileTool(fs: FsProvider): Tool {
  return {
    name: 'edit_file',
    description: 'Replace a unique string in a file (old_string must occur exactly once).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'file path relative to the workspace root' },
        old_string: { type: 'string', description: 'exact text to replace; must be unique in the file' },
        new_string: { type: 'string', description: 'replacement text' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(args: unknown): Promise<string> {
      const path = stringField(args, 'path')
      const oldString = stringField(args, 'old_string')
      const newString = stringField(args, 'new_string')
      const content = await fs.readText(path)
      const count = content.split(oldString).length - 1
      if (count === 0) {
        throw new Error(`old_string not found in ${path}`)
      }
      if (count > 1) {
        throw new Error(`old_string appears ${count} times in ${path}; provide more context to make it unique`)
      }
      await fs.writeText(path, content.replace(oldString, newString))
      return `edited ${path} (1 replacement)`
    },
  }
}

export function createBashTool(subprocess: SubprocessProvider, cwd: string): Tool {
  return {
    name: 'bash',
    description: 'Run a shell command in the workspace (e.g. run the test suite).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'shell command to run' },
      },
      required: ['command'],
    },
    async execute(args: unknown): Promise<string> {
      const command = stringField(args, 'command')
      const result = await subprocess.run(command, { cwd })
      const parts = [
        `exit code: ${result.exitCode ?? 'null'}${result.timedOut ? ' (timed out)' : ''}`,
      ]
      if (result.stdout) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
      if (result.stderr) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
      return parts.join('\n')
    },
  }
}

/** 四个真工具的标准组合（跑测试、修代码的最小工具面）。 */
export function createTools(fs: FsProvider, subprocess: SubprocessProvider, cwd: string): Tool[] {
  return [
    createReadFileTool(fs),
    createEditFileTool(fs),
    createWriteFileTool(fs),
    createBashTool(subprocess, cwd),
  ]
}

