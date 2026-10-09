/** 找第一个匹配的位置：全局正则的 lastIndex 会在调用之间保留。 */
const pattern = /ab/g

export function firstMatchIndex(text: string): number {
  return pattern.exec(text)?.index ?? -1
}
