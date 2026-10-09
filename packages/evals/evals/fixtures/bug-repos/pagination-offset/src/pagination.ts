/** 页码是 1 起：第 1 页的偏移应该是 0。 */
export function offsetForPage(page: number, pageSize: number): number {
  return page * pageSize
}
