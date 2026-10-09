/** 由查询参数生成缓存键：键顺序不同也必须是同一个键。 */
export function cacheKey(query: Record<string, number>): string {
  return JSON.stringify(query)
}
