import { test } from 'node:test'
import assert from 'node:assert/strict'
import { takeNext } from '../src/queue.ts'

test('the caller queue is left untouched', () => {
  const queue = ['a', 'b']
  assert.equal(takeNext(queue), 'a')
  assert.deepEqual(queue, ['a', 'b'])
})
