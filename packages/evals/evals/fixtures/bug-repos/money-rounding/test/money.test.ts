import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sumYuan } from '../src/money.ts'

test('sums cents without floating point drift', () => {
  assert.equal(sumYuan([10, 20]), 0.3)
  assert.equal(sumYuan([1, 2, 3, 4, 5, 6, 7, 8, 9]), 0.45)
})
