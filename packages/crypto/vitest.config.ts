import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'crypto',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
