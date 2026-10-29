import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'api-contracts',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
