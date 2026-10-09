import { test } from 'node:test'
import assert from 'node:assert/strict'
import { containsNaN } from '../src/scan.ts'

test('detects NaN and ignores ordinary numbers', () => {
  assert.equal(containsNaN([1, Number.NaN]), true)
  assert.equal(containsNaN([1, 2]), false)
})
