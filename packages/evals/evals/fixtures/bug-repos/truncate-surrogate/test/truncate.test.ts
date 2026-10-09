import { test } from 'node:test'
import assert from 'node:assert/strict'
import { truncate } from '../src/truncate.ts'

test('never splits a surrogate pair', () => {
  const text = 'ab\u{1F600}cd'
  assert.equal(truncate(text, 3), "ab\u{1F600}")
  assert.equal([...truncate(text, 2)].length, 2)
})
