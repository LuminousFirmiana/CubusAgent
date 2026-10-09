import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortedCopy } from '../src/sorted.ts'

test('sortedCopy sorts without touching the input', () => {
  const input = [3, 1, 2]
  assert.deepEqual(sortedCopy(input), [1, 2, 3])
  assert.deepEqual(input, [3, 1, 2])
})
