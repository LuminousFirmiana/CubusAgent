import { DeepSeekAdapter } from '@cubus/llm'
import { withLlmRetry } from '@cubus/llm-retry'
import {
  CliUsageError,
  CODING_COMMAND_HELP,
  parseCodingCommand,
  renderCodingResult,
  runCodingCommand,
} from './coding.ts'
import { createTerminalApprovalPrompter } from './approval.ts'
import { defaultEnvFile, loadDeepSeekEnvironment } from './config.ts'

const output = { write: (line: string) => process.stdout.write(line + '\n') }

async function main(args: readonly string[]): Promise<number> {
  const command = args[0]
  if (command === '--help' || command === '-h' || command === undefined) {
    output.write(CODING_COMMAND_HELP)
    return command === undefined ? 2 : 0
  }
  if (command !== 'coding') throw new CliUsageError(`unknown command: ${command}`)

  const parsed = parseCodingCommand(args.slice(1))
  if (parsed.help) {
    output.write(CODING_COMMAND_HELP)
    return 0
  }
  const options = parsed.options!
  const controller = new AbortController()
  const onInterrupt = (): void => controller.abort(new Error('cancelled'))
  process.once('SIGINT', onInterrupt)
  let result: Awaited<ReturnType<typeof runCodingCommand>>
  try {
    result = await runCodingCommand(options, {
      approvalPrompter: createTerminalApprovalPrompter(),
      signal: controller.signal,
      // runCodingCommand calls this only after argument, trust, and workspace checks pass.
      async prepareAdapterFactory() {
        const adapterConfig = await loadDeepSeekEnvironment(process.env, defaultEnvFile())
        const apiKey = adapterConfig.DEEPSEEK_API_KEY
        if (!apiKey) throw new CliUsageError('DEEPSEEK_API_KEY is required in the environment or repository .env')
        return () => withLlmRetry(
          new DeepSeekAdapter({
            baseUrl: adapterConfig.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
            apiKey,
            model: adapterConfig.DEEPSEEK_MODEL ?? 'deepseek-chat',
          }),
          { maxAttempts: options.maxModelAttempts ?? 3 },
        )
      },
    })
  } catch (error) {
    if (controller.signal.aborted) return 130
    throw error
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
  renderCodingResult(result, output)
  return result.cancelled ? 130 : 0
}

const args = process.argv.slice(2)
// pnpm run preserves the separator as argv[0]; direct node invocation does not.
if (args[0] === '--') args.shift()

try {
  process.exitCode = await main(args)
} catch (error) {
  process.stderr.write(`cubus: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = error instanceof CliUsageError ? 2 : 1
}
