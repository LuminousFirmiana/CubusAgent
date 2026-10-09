/** 收集：必须等所有异步任务完成后再返回。 */
export async function collectAll(items: number[]): Promise<number[]> {
  const results: number[] = []
  items.forEach(async item => {
    await Promise.resolve()
    results.push(item * 2)
  })
  return results.slice()
}
