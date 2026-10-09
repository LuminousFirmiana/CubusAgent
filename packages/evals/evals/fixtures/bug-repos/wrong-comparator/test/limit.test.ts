import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exceedsLimit } from '../src/limit.ts'

test('a value equal to the limit is allowed', () => {
  assert.equal(exceedsLimit(10, 10), false)
})

test('a value above the limit is rejected', () => {
  assert.equal(exceedsLimit(11, 10), true)
})
