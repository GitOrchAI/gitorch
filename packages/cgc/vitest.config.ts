import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    testTimeout: 15000,
    forks: {
      singleFork: true,
    },
  },
  resolve: {
    alias: {
      '@gitorch/cgc': path.resolve(__dirname, './src/index.ts'),
    },
  },
})
