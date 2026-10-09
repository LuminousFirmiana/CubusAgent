import { test } from 'node:test'
import assert from 'node:assert/strict'
import { average } from '../src/average.ts'

test('average of an empty list is zero', () => {
  assert.equal(average([]), 0)
})

test('average of numbers', () => {
  assert.equal(average([2, 4]), 3)
})
