import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    testTimeout: 20000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@gitorch/cgc': path.resolve(__dirname, './src/index.ts'),
    },
  },
})
