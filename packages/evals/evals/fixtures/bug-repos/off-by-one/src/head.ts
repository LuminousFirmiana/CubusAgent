export function head<T>(items: T[], count: number): T[] {
  const out: T[] = []
  for (let i = 0; i <= count; i += 1) out.push(items[i]!)
  return out
}
