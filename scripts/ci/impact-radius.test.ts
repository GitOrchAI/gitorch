import { expect, test } from 'vitest'
import { impactedPackages } from './impact-radius'

test('classifies cgc change as cgc package impact', () => {
  const changed = ['packages/cgc/src/core/indexer.ts']
  expect(impactedPackages(changed)).toContain('@gitorch/cgc')
})

test('classifies root change as all-package impact', () => {
  const changed = ['package.json']
  expect(impactedPackages(changed)).toContain('@gitorch/cgc')
  expect(impactedPackages(changed)).toContain('@gitorch/cortex')
})
