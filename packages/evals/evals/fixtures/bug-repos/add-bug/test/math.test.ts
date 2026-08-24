import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add } from '../src/math.ts'

test('add returns the sum', () => {
  assert.equal(add(2, 3), 5)
})

test('add handles negative numbers', () => {
  assert.equal(add(-1, 1), 0)
})
