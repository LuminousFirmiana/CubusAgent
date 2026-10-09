import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEnabled } from '../src/flags.ts'

test('the literal string false disables the flag', () => {
  assert.equal(isEnabled('false'), false)
  assert.equal(isEnabled('true'), true)
  assert.equal(isEnabled(undefined), false)
})
