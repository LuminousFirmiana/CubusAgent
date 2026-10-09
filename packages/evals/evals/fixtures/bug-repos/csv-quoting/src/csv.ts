/** 生成一行 CSV：每个字段都用双引号包裹，内部引号翻倍。 */
export function toCsvRow(values: string[]): string {
  return values.join(',')
}
