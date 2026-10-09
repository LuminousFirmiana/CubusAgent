export function sumAll(values: string[]): number {
  let total = 0
  for (const value of values) total += value as unknown as number
  return total
}
