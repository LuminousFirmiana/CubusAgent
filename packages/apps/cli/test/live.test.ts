import { expect, test } from 'vitest'
import { createLiveRenderer, summarizeToolArgs } from '../src/live.ts'

function collect() {
  const lines: string[] = []
  return { lines, output: { write: (line: string) => lines.push(line) } }
}

test('buffers streamed text into lines and flushes the remainder', () => {
  const { lines, output } = collect()
  const renderer = createLiveRenderer(output)

  renderer.onEvent({ type: 'assistant/chunk', stepId: 's1', delta: 'hello' })
  renderer.onEvent({ type: 'assistant/chunk', stepId: 's1', delta: ' world\npartial' })
  expect(lines).toEqual(['  hello world'])

  renderer.onEvent({ type: 'assistant/message', messageId: 'm1', stepId: 's1', content: [] })
  expect(lines).toEqual(['  hello world', '  partial'])
})

test('renders tool cards with argument summaries and results with status', () => {
  const { lines, output } = collect()
  const renderer = createLiveRenderer(output)

  renderer.onEvent({ type: 'assistant/chunk', stepId: 's1', delta: 'working' })
  renderer.onEvent({
    type: 'tool/call',
    id: 'c1',
    stepId: 's1',
    name: 'edit_file',
    args: { path: 'note.txt', old_string: 'a', new_string: 'b' },
  })
  renderer.onEvent({ type: 'tool/result', id: 'c1', ok: true, output: { text: 'edited note.txt (1 replacement)\nmore' } })
  renderer.onEvent({ type: 'tool/result', id: 'c2', ok: false, output: { text: 'boom' } })

  expect(lines).toEqual([
    '  working',
    '→ edit_file note.txt',
    '← ok edited note.txt (1 replacement)',
    '← failed boom',
  ])
})

test('summarizeToolArgs prefers path, command, pattern, then compact JSON', () => {
  expect(summarizeToolArgs({ path: 'a.ts', command: 'x' })).toBe('a.ts')
  expect(summarizeToolArgs({ command: 'npm test' })).toBe('npm test')
  expect(summarizeToolArgs({ pattern: 'TODO' })).toBe('TODO')
  expect(summarizeToolArgs({ x: 1, y: 'z' })).toBe('{"x":1,"y":"z"}')
  expect(summarizeToolArgs(null)).toBe('')
  expect(summarizeToolArgs({ path: 'x'.repeat(100) })).toHaveLength(80)
})

test('ignores thinking deltas and lifecycle events in the live view', () => {
  const { lines, output } = collect()
  const renderer = createLiveRenderer(output)

  renderer.onEvent({ type: 'turn/start', turnId: 't1' })
  renderer.onEvent({ type: 'assistant/chunk', stepId: 's1', thinkingDelta: 'thinking...' })
  renderer.onEvent({ type: 'user/message', messageId: 'm1', content: [] })
  renderer.onEvent({ type: 'turn/end', turnId: 't1' })
  renderer.flush()

  expect(lines).toEqual([])
})
