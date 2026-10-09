import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasKey } from '../src/registry.ts'

test('inherited properties do not count as registered keys', () => {
  assert.equal(hasKey({ a: 1 }, "a"), true)
  assert.equal(hasKey({ a: 1 }, "toString"), false)
})
