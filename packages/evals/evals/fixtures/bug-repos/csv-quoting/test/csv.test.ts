import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCsvRow } from '../src/csv.ts'

test('quoting survives commas and embedded quotes', () => {
  assert.equal(toCsvRow(['a', 'b,c']), '"a","b,c"')
  assert.equal(toCsvRow(['say "hi"']), '"say ""hi"""')
})
