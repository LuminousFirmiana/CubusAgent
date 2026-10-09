/** 取本地日期（YYYY-MM-DD）。 */
export function localDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}
