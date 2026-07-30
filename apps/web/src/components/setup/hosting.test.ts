import { describe, test, expect } from 'vitest'
import { locales } from '../../locales'

describe('Hosting Selection i18n keys', () => {
  test('defines hosting keys across en, pt, and es', () => {
    const keys = [
      'hostingTitle',
      'hostingDesc',
      'hostingCloudTitle',
      'hostingCloudBadge',
      'hostingCloudDesc',
      'hostingVmTitle',
      'hostingVmBadge',
      'hostingVmDesc',
      'hostingVmNote',
    ]

    for (const lang of ['en', 'pt', 'es'] as const) {
      const setupObj = locales[lang].setup as Record<string, string>
      for (const key of keys) {
        expect(setupObj[key]).toBeDefined()
        expect(typeof setupObj[key]).toBe('string')
        expect(setupObj[key].length).toBeGreaterThan(0)
      }
    }
  })
})
