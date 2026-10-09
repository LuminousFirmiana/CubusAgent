/** 数组里有没有 NaN（indexOf 用 === 比较，NaN 永远不相等）。 */
export function containsNaN(values: number[]): boolean {
  return values.indexOf(Number.NaN) >= 0
}
