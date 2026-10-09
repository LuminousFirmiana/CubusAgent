import { test } from 'node:test'
import assert from 'node:assert/strict'
import { removeAt } from '../src/list.ts'

test('removes exactly one element in place', () => {
  assert.deepEqual(removeAt(['a', 'b', 'c'], 1), ['a', 'c'])
})
