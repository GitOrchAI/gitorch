import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

test('audit summary references required reports', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  const action = readFileSync('.github/actions/upload-ci-audit/action.yml', 'utf8')
  expect(ci).toContain('./.github/actions/upload-ci-audit')
  expect(action).toContain('actions/upload-artifact@v4')
  expect(action).toContain('ci/audit/**')
})
