import { test } from 'node:test'
import assert from 'node:assert/strict'
import { head } from '../src/head.ts'

test('head returns exactly count items', () => {
  assert.deepEqual(head(['a', 'b'], 2), ['a', 'b'])
})

test('head tolerates count larger than the list', () => {
  assert.deepEqual(head(['a'], 1), ['a'])
})
