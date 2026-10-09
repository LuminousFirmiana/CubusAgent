import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCount } from '../src/parse.ts'

test('parseCount parses digits', () => {
  assert.equal(parseCount('42'), 42)
})

test('parseCount rejects non-numeric input', () => {
  assert.throws(() => parseCount('abc'))
})
