/** 退避序列：attempts 次重试对应 attempts 个延迟。 */
export function retryDelays(attempts: number): number[] {
  const delays: number[] = []
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    delays.push(2 ** attempt * 100)
  }
  return delays
}
