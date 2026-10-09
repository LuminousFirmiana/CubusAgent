/** 缺省值：只有 undefined 才用兜底，0 是合法值。 */
export function withDefault(value: number | undefined, fallback: number): number {
  return value || fallback
}
