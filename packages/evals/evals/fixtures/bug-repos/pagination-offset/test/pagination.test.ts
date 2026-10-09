import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offsetForPage } from '../src/pagination.ts'

test('the first page starts at offset zero', () => {
  assert.equal(offsetForPage(1, 10), 0)
  assert.equal(offsetForPage(3, 10), 20)
})
