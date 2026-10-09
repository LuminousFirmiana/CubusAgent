import { test } from 'node:test'
import assert from 'node:assert/strict'
import { localDay } from '../src/day.ts'

/**
 * 时区由 testCommand 钉死为 UTC+8（POSIX 形式 TZ=UTC-8，不依赖 tzdata）：
 * 本地 00:30 落在 UTC 的前一天，因此无论跑测机器在哪个时区（CI 是 UTC），
 * 这个 bug 都必然可见 —— 环境相关的东西必须由夹具自己钉死。
 */
test('uses local calendar fields, not UTC', () => {
  const date = new Date(2026, 0, 2, 0, 30, 5)
  assert.equal(localDay(date), '2026-01-02')
})
