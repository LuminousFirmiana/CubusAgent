import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortNumbers } from '../src/sort.ts'

test('sorts numerically, not lexicographically', () => {
  assert.deepEqual(sortNumbers([10, 9, 100]), [9, 10, 100])
})
