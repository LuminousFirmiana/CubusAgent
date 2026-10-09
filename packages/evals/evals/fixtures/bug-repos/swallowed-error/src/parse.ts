export function parseCount(text: string): number {
  const value = Number.parseInt(text, 10)
  if (Number.isNaN(value)) return 0
  return value
}
