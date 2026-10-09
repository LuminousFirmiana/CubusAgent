import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cloneConfig } from '../src/clone.ts'

test('mutating the clone does not touch the original', () => {
  const original = { name: 'a', nested: { retries: 3 } }
  const copy = cloneConfig(original)
  copy.nested.retries = 99
  assert.equal(original.nested.retries, 3)
})
