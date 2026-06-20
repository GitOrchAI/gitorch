import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

test('ci.yml uses GitHub-hosted ubuntu-latest runner', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  expect(ci).toContain('runs-on: ubuntu-latest')
  expect(ci).not.toContain('runs-on: self-hosted')
})

test('ci.yml installs dependencies with frozen lockfile', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  expect(ci).toContain('pnpm install --frozen-lockfile')
})
