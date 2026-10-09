import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeFirst } from '../src/first.ts'

test('describeFirst reports the first value', async () => {
  assert.equal(await describeFirst([3, 4]), 'first=3')
})
