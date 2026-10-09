import { test } from 'node:test'
import assert from 'node:assert/strict'
import { uniquePairs } from '../src/dedupe.ts'

test('equal pairs collapse regardless of identity', () => {
  const result = uniquePairs([{ a: 1, b: 2 }, { a: 1, b: 2 }, { a: 3, b: 4 }])
  assert.deepEqual(result, [{ a: 1, b: 2 }, { a: 3, b: 4 }])
})
