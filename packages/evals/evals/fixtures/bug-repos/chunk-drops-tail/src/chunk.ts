/** 按 size 切块：不足一块的尾巴也要保留。 */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index + size < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}
