/** 升序排序：默认 sort() 会把数字当字符串比较。 */
export function sortNumbers(values: number[]): number[] {
  return [...values].sort()
}
