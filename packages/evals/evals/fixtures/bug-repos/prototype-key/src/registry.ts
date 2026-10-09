/** 判断注册表里有没有这个键（不能把原型链上的东西算进来）。 */
export function hasKey(registry: Record<string, number>, key: string): boolean {
  return key in registry
}
