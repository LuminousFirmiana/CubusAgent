import { expect, test } from 'vitest'
import type { GitChangeReport } from '@cubus/git'
import type { SessionEvent } from '@cubus/session'
import {
  behaviorFingerprint,
  compareFingerprints,
  FINGERPRINT_CALL_BUDGET_SLACK,
  goldenPathFor,
  parseGolden,
  renderFingerprintComparison,
  renderGolden,
} from '../src/fingerprint.ts'
import type { BehaviorFingerprint } from '../src/fingerprint.ts'

const events: SessionEvent[] = [
  { type: 'turn/start', turnId: 't1' },
  { type: 'step/start', stepId: 's1', turnId: 't1' },
  { type: 'assistant/chunk', stepId: 's1', delta: '嗯' },
  { type: 'assistant/message', messageId: 'm1', stepId: 's1', content: [] },
  { type: 'tool/call', id: 'c1', stepId: 's1', name: 'read_file', args: { path: 'src/math.ts' } },
  { type: 'tool/result', id: 'c1', ok: true, output: { text: 'ok' } },
  { type: 'tool/call', id: 'c2', stepId: 's1', name: 'bash', args: { command: 'node --test test/' } },
  { type: 'tool/result', id: 'c2', ok: false, output: { text: 'failed' } },
  { type: 'step/end', stepId: 's1' },
  { type: 'turn/end', turnId: 't1' },
]

const changes: GitChangeReport = {
  isRepository: true,
  head: null,
  changed: [
    { path: 'src/math.ts', kind: 'modified', addedLines: 1, removedLines: 1 },
    { path: 'src/extra.ts', kind: 'created', addedLines: 3, removedLines: 0 },
  ],
  preexisting: [],
  summary: '',
}

function fingerprint(overrides: Partial<BehaviorFingerprint> = {}): BehaviorFingerprint {
  return {
    judge: 'pass',
    events: ['turn/start', 'step/start', 'tool/call:read_file', 'tool/result:read_file:ok'],
    tools: ['read_file', 'edit_file'],
    files: [{ path: 'src/math.ts', kind: 'modified' }],
    ...overrides,
  }
}

test('a fingerprint keeps behaviour and drops noise (stream fragments, assembly, parameters)', () => {
  const print = behaviorFingerprint({ events, judge: 'pass', changes })

  expect(print.tools).toEqual(['read_file', 'bash'])
  expect(print.events).toEqual([
    'turn/start',
    'step/start',
    'assistant/message',
    'tool/call:read_file',
    'tool/result:read_file:ok',
    'tool/call:bash',
    'tool/result:bash:failed',
    'step/end',
    'turn/end',
  ])
  // 文件集来自 Git 报告并排序；不含行数（行数会随风格变化）
  expect(print.files).toEqual([
    { path: 'src/extra.ts', kind: 'created' },
    { path: 'src/math.ts', kind: 'modified' },
  ])
})

test('a non-repository workspace simply contributes no file set', () => {
  const print = behaviorFingerprint({
    events,
    judge: 'pass',
    changes: { isRepository: false, head: null, changed: [], preexisting: [], summary: 'not a git repository' },
  })
  expect(print.files).toEqual([])
})

test('the gate rules: judge, files, call budget always; tool identity only when asked', () => {
  const golden = fingerprint()

  // 1. 判分必须仍然通过
  expect(compareFingerprints(golden, fingerprint({ judge: 'fail' })).differences[0]).toBe('judge: expected pass, got fail')

  // 2. 文件集必须一致（多改一个文件 = 越界，少改 = 没做完）
  const extraFile = compareFingerprints(golden, fingerprint({
    files: [{ path: 'src/math.ts', kind: 'modified' }, { path: 'src/oops.ts', kind: 'created' }],
  }))
  expect(extraFile.ok).toBe(false)
  expect(extraFile.differences[0]).toContain('extra [src/oops.ts:created]')

  // 3a. strict：序列必须完全一致
  expect(compareFingerprints(golden, fingerprint({ tools: ['read_file', 'edit_file', 'bash'] }), 'strict').ok).toBe(false)
  // 3b. subsequence：golden 的工具按序出现即可，允许夹带其它工具
  expect(compareFingerprints(golden, fingerprint({ tools: ['bash', 'read_file', 'edit_file', 'bash'] }), 'subsequence').ok).toBe(true)
  expect(compareFingerprints(golden, fingerprint({ tools: ['edit_file', 'read_file'] }), 'subsequence').ok).toBe(false)
  // 3c. guardrails（默认）：不比工具身份 —— 用 bash cat 读文件而不是 read_file 不算回归
  expect(compareFingerprints(golden, fingerprint({ tools: ['bash', 'edit_file'] })).ok).toBe(true)
  expect(compareFingerprints(golden, fingerprint({ tools: [] }), 'guardrails').ok).toBe(true)

  // 4. 调用预算：不超过 golden + 3
  const withinBudget = fingerprint({
    tools: Array.from({ length: golden.tools.length + FINGERPRINT_CALL_BUDGET_SLACK }, () => 'read_file'),
  })
  expect(compareFingerprints(golden, withinBudget, 'guardrails').ok).toBe(true)
  const overBudget = fingerprint({
    tools: Array.from({ length: golden.tools.length + FINGERPRINT_CALL_BUDGET_SLACK + 1 }, () => 'read_file'),
  })
  const comparison = compareFingerprints(golden, overBudget, 'guardrails')
  expect(comparison.ok).toBe(false)
  expect(comparison.differences.join(' ')).toContain('call budget')

  // 人类可读报告（golden 命令打印它）
  const report = renderFingerprintComparison(golden, overBudget, comparison)
  expect(report).toContain('gate: FAIL')
  expect(report).toContain('tools  golden: [read_file, edit_file]')
})

test('golden files round-trip and a broken golden is rejected loudly', () => {
  const golden = fingerprint()
  expect(parseGolden(renderGolden(golden), 'golden.json')).toEqual(golden)
  expect(goldenPathFor('/tmp/fixture')).toBe('/tmp/fixture/golden.json')

  expect(() => parseGolden('{ nope', 'golden.json')).toThrow('golden.json: golden is not valid JSON')
  expect(() => parseGolden('{"judge":"maybe","tools":[],"events":[],"files":[]}', 'golden.json'))
    .toThrow('golden.judge must be pass or fail')
  expect(() => parseGolden('{"judge":"pass","tools":"x","events":[],"files":[]}', 'golden.json'))
    .toThrow('golden.tools must be an array of strings')
  expect(() => parseGolden('{"judge":"pass","tools":[],"events":[],"files":{}}', 'golden.json'))
    .toThrow('golden.files must be an array')
})
