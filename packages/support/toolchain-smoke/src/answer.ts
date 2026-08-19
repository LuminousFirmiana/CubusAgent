/**
 * 冒烟函数：只是用来验证工具链的靶子。
 * 类型标注 number 意思是"这个函数保证返回数字"——如果代码违背承诺，tsc 会报警。
 */
export function answer(): number {
  // var xyz = 1
  return parseInt("42")
}
