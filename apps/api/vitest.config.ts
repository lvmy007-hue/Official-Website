import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// 后端测试需要装饰器元数据（依赖注入），esbuild 不支持，改用 swc 转换。
export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    name: 'api',
    include: ['src/**/*.test.ts'],
    // 需要真实数据库的测试单独在 api-db 项目里运行（见 vitest.db.config.ts）
    exclude: ['src/**/*.db.test.ts', '**/node_modules/**'],
    environment: 'node',
    // 每个 http 测试文件的首个用例要启动整个应用；多文件并行时默认 5 秒偏紧，放宽到 30 秒（不影响单个用例的实际耗时）。
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      APP_MODE: 'test',
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
    },
  },
})
