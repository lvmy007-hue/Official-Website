import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// 真实数据库测试：启动嵌入式 PostgreSQL，执行全部迁移，再验证分区、行级安全、幂等等行为。
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
    name: 'api-db',
    include: ['src/**/*.db.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // 数据库进程较重，文件之间串行执行，避免端口与内存争用。
    fileParallelism: false,
    pool: 'forks',
    env: {
      APP_MODE: 'test',
      LOG_LEVEL: 'silent',
      JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
    },
  },
})
