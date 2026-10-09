import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameEmail } from '../src/email.ts'

test('compares emails case-insensitively and ignores padding', () => {
  assert.equal(sameEmail('A@Example.com', ' a@example.COM '), true)
  assert.equal(sameEmail('a@example.com', 'b@example.com'), false)
})
