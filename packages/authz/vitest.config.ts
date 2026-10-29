import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'authz',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
