export async function firstItem(values: number[]): Promise<number | undefined> {
  return values[0]
}

export function describeFirst(values: number[]): string {
  const value = firstItem(values)
  return 'first=' + String(value)
}
