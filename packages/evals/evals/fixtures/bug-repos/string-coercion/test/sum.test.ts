import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sumAll } from '../src/sum.ts'

test('sumAll adds numeric strings', () => {
  assert.equal(sumAll(['1', '2', '3']), 6)
})
