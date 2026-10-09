import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify } from '../src/classify.ts'

test('non-negative numbers are classified separately', () => {
  assert.equal(classify(-1), 'negative')
  assert.equal(classify(0), 'non-negative')
  assert.equal(classify(7), 'non-negative')
})
