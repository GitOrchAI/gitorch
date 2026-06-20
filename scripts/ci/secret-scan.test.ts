import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

test('security workflow includes CodeQL and gitleaks action', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  const codeql = readFileSync('.github/workflows/codeql-analysis.yml', 'utf8')
  expect(ci).toContain('gitleaks/gitleaks-action@v2')
  expect(codeql).toContain('github/codeql-action/analyze@v3')
})
