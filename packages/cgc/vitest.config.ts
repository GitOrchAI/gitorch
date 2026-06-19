import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@gitorch/cgc': path.resolve(__dirname, './src/index.ts'),
    },
  },
})