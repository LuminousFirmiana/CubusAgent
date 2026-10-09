/** 读取布尔开关：环境变量里 "false" 也是非空字符串。 */
export function isEnabled(raw: string | undefined): boolean {
  return Boolean(raw)
}
