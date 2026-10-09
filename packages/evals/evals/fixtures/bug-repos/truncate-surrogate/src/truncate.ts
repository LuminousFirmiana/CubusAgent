/** 按字符截断（不能把 emoji 劈成两半）。 */
export function truncate(text: string, maxChars: number): string {
  return text.slice(0, maxChars)
}
