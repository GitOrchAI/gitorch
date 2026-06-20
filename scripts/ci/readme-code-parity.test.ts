import { expect, test } from 'vitest'
import { checkImplementedClaims } from './readme-code-parity'

test('README parity script checks implemented roadmap items', () => {
  expect(checkImplementedClaims()).toEqual([])
})
