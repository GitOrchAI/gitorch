import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

test('playwright config is headless only', () => {
  const config = readFileSync('playwright.config.ts', 'utf8')
  expect(config).toContain('headless: true')
  expect(config).toContain("trace: 'retain-on-failure'")
  expect(config).toContain("video: 'retain-on-failure'")
})
