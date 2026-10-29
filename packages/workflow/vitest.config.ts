import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'workflow',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
