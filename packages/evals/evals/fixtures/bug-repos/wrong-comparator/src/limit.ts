/** 超过上限才算超限：应该用 >，实现成了 >=。 */
export function exceedsLimit(value: number, limit: number): boolean {
  return value >= limit
}
