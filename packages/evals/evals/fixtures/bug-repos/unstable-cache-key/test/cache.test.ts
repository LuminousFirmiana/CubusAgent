import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cacheKey } from '../src/cache.ts'

test('key order does not change the cache key', () => {
  assert.equal(cacheKey({ a: 1, b: 2 }), cacheKey({ b: 2, a: 1 }))
  assert.notEqual(cacheKey({ a: 1 }), cacheKey({ a: 2 }))
})
