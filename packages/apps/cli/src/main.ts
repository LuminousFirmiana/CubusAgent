import { CredentialsError, LocalCredentials } from '@cubus/credentials'
import {
  CliUsageError,
  CODING_COMMAND_HELP,
  parseCodingCommand,
  renderCodingResult,
  runCodingCommand,
} from './coding.ts'
import { createTerminalApprovalPrompter } from './approval.ts'
import { defaultEnvFile, loadDeepSeekEnvironment } from './config.ts'
import { createModelAdapterFactory, MODEL_CREDENTIAL_NAME } from './model.ts'

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
  // 只有名字进日志/快照，值只存在于取用瞬间（见 @cubus/credentials）。
  let modelCredential: string | undefined
  const credentials = new LocalCredentials({
    sources: { [MODEL_CREDENTIAL_NAME]: () => modelCredential },
  })
  const controller = new AbortController()
  const onInterrupt = (): void => controller.abort(new Error('cancelled'))
  process.once('SIGINT', onInterrupt)
  let result: Awaited<ReturnType<typeof runCodingCommand>>
  try {
    result = await runCodingCommand(options, {
      approvalPrompter: createTerminalApprovalPrompter(),
      output,
      signal: controller.signal,
      // 凭据来源由 app 决定（环境变量 / .env），但明文只经 credentials seam 的租约取出（C3）。
      credentials,
      // runCodingCommand calls this only after argument, trust, and workspace checks pass.
      async prepareAdapterFactory() {
        const settings = await loadDeepSeekEnvironment(process.env, defaultEnvFile())
        modelCredential = settings.DEEPSEEK_API_KEY
        try {
          return await createModelAdapterFactory({
            credentials,
            settings,
            maxAttempts: options.maxModelAttempts ?? 3,
          })
        } catch (error) {
          if (error instanceof CredentialsError) {
            throw new CliUsageError('DEEPSEEK_API_KEY is required in the environment or repository .env')
          }
          throw error
        }
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
