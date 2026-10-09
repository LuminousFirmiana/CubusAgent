import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig } from '../src/parse.ts'

test('invalid JSON raises instead of silently returning undefined', () => {
  assert.throws(() => parseConfig('{oops'))
  assert.deepEqual(parseConfig('{"a":1}'), { a: 1 })
})
