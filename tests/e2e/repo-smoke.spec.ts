import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'

test('repository exposes package manifest', async () => {
  expect(existsSync('package.json')).toBe(true)
})
