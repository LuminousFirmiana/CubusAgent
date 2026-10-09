import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectAll } from '../src/collect.ts'

test('waits for every async task', async () => {
  assert.deepEqual(await collectAll([1, 2, 3]), [2, 4, 6])
})
