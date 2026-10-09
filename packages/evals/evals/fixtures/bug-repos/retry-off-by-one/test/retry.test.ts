import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryDelays } from '../src/retry.ts'

test('produces exactly one delay per retry', () => {
  assert.deepEqual(retryDelays(3), [100, 200, 400])
  assert.deepEqual(retryDelays(0), [])
})
