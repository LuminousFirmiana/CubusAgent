/** 解析配置：非法 JSON 必须抛出，不能静默返回 undefined。 */
export function parseConfig(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
