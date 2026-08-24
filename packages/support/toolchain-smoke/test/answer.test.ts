import { expect, test } from 'vitest'
import { answer } from '../src/answer.ts'

test('answer returns 42', () => {
  expect(answer()).toBe(42)
})
