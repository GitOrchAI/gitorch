import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

test('root lint script enforces max warnings zero', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>
  }
  expect(pkg.scripts?.['lint:ci']).toContain('--max-warnings 0')
})

test('strict typecheck script exists', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>
  }
  expect(pkg.scripts?.['typecheck:strict']).toContain(
    'pnpm exec tsx scripts/ci/run-typecheck-strict.ts'
  )
})
