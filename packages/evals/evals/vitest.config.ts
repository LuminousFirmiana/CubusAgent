import { defineConfig } from 'vitest/config'

// fixture 仓库（永远带 bug 的原样仓库）不进 vitest 扫描范围
export default defineConfig({
  test: {
    exclude: ['fixtures/**', 'node_modules/**'],
  },
})
