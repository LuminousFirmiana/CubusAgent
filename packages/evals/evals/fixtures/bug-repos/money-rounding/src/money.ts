/** 金额以"分"为单位计算，返回元（两位小数）。 */
export function sumYuan(cents: number[]): number {
  const total = cents.reduce((sum, cent) => sum + cent / 100, 0)
  return total
}
