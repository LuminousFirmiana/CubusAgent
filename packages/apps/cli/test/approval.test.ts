import { expect, test } from 'vitest'
import { createCliToolApproval } from '../src/index.ts'

const request = { toolName: 'bash', args: { command: 'pnpm test' } }
const signal = new AbortController().signal
const context = { signal }

test('allow and deny modes are deterministic without a prompter', async () => {
  expect(await createCliToolApproval('allow').decide(request, context)).toMatchObject({ outcome: 'allow' })
  expect(await createCliToolApproval('deny').decide(request, context)).toMatchObject({ outcome: 'deny' })
})

test('ask defaults to deny outside an interactive terminal', async () => {
  const decision = await createCliToolApproval('ask', {
    interactive: false,
    async confirm() { throw new Error('must not prompt') },
  }).decide(request, context)

  expect(decision).toEqual({ outcome: 'deny', reason: 'interactive approval unavailable' })
})

test('ask follows the interactive confirmation result', async () => {
  const seen: unknown[] = []
  const allowed = await createCliToolApproval('ask', {
    interactive: true,
    async confirm(value, receivedSignal) {
      seen.push(value, receivedSignal)
      return true
    },
  }).decide(request, context)

  expect(seen).toEqual([request, signal])
  expect(allowed).toEqual({ outcome: 'allow', reason: 'approved interactively' })
})
