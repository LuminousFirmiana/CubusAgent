/** 深拷贝：嵌套对象也要复制，不能共享引用。 */
export function cloneConfig(config: { name: string; nested: { retries: number } }) {
  return { ...config }
}
