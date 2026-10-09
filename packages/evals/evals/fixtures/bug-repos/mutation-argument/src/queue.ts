/** 取出下一个：不能改动调用方的队列。 */
export function takeNext(queue: string[]): string | undefined {
  return queue.shift()
}
