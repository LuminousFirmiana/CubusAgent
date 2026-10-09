/** 就地删除第 index 个元素。 */
export function removeAt(items: string[], index: number): string[] {
  items.slice(index, 1)
  return items
}
