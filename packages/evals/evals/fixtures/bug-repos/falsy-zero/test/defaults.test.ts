import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withDefault } from '../src/defaults.ts'

test('zero is a real value, not a missing one', () => {
  assert.equal(withDefault(0, 42), 0)
  assert.equal(withDefault(undefined, 42), 42)
})
