import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

// 前端（官网与 ERP）测试：只收集 src 下的测试文件。后端与工作进程各自有独立配置。
// 组件测试（.test.tsx）使用 jsdom；纯逻辑测试（.test.ts）仍在 node 环境运行。
export default defineConfig({
  resolve: {
    alias: {
      '@nova/api-contracts': fromRoot('./packages/api-contracts/src/index.ts'),
      '@nova/authz': fromRoot('./packages/authz/src/index.ts'),
    },
  },
  test: {
    name: 'web',
    include: ['src/**/*.test.{ts,tsx}'],
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
    setupFiles: ['./src/erp/test/setup.ts'],
    testTimeout: 15_000,
  },
})
