/** 按取值去重：{a,b} 相同即视为重复。 */
export function uniquePairs(pairs: { a: number; b: number }[]): { a: number; b: number }[] {
  return [...new Set(pairs)]
}
