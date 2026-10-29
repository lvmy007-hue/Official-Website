import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'tenancy',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
