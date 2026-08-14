import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // 用本地桩替换真实 koishi，避免加载 @koishijs/loader 的环境问题
      koishi: path.resolve(process.cwd(), 'test/koishi-stub.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
})
