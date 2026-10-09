import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstMatchIndex } from '../src/match.ts'

test('repeated calls return the same first match', () => {
  assert.equal(firstMatchIndex('abab'), 0)
  assert.equal(firstMatchIndex('abab'), 0)
})
