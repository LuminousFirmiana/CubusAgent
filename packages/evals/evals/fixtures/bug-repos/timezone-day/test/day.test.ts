import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localDay } from '../src/day.ts'

test('uses local calendar fields, not UTC', () => {
  const date = new Date(2026, 0, 2, 3, 4, 5)
  assert.equal(localDay(date), '2026-01-02')
})
