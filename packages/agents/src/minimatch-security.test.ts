import { describe, it, expect } from 'vitest'
import { minimatch, Minimatch } from 'minimatch'

describe('Minimatch Security (ReDoS)', () => {
  it('should not generate exponential backtracking regex for nested extglobs', () => {
    // CVE-2026-27904: nested *() or +() should not result in (?:(?:...)*)*
    const pattern = '*(*(*(a|b)))'
    const mm = new Minimatch(pattern, {})

    // In fixed versions, nested extglobs are flattened or optimized
    // For depth=3, the dangerous regex was /^(?:(?:(?:a|b)*)*)*$/
    const regexString = mm.set?.[0]?.[0]?.toString()

    // We expect the regex not to have the (?:(?: pattern characteristic of catastrophic backtracking
    // The current fix in 10.2.5 simplifies this to /^(?:a|b)*$/
    expect(regexString).not.toMatch(/\(\?:\(\?:\(\?:/)
  })

  it('should handle complex patterns in a reasonable time', () => {
    const pattern = '*(*(*(a|b)))'
    const input = 'a'.repeat(50) + 'z'

    const start = performance.now()
    const result = minimatch(input, pattern)
    const end = performance.now()

    const duration = end - start

    expect(result).toBe(false)
    // Even on slow CI environments, 100ms is very generous for a fixed pattern that should take <1ms
    expect(duration).toBeLessThan(100)
  })

  it('should handle +() extglobs safely', () => {
    const pattern = '+(+(+(a|b)))'
    const input = 'a'.repeat(50) + 'z'

    const start = performance.now()
    const result = minimatch(input, pattern)
    const end = performance.now()

    const duration = end - start

    expect(result).toBe(false)
    expect(duration).toBeLessThan(100)
  })

  it('should handle repeated wildcards with non-matching literal (CVE-2026-26996)', () => {
    // Pattern with many consecutive * followed by a literal character that doesn't appear in the test string
    const N = 34
    const pattern = '*'.repeat(N) + 'X' + '*'.repeat(3)
    const input = 'A'.repeat(50)

    const start = performance.now()
    const result = minimatch(input, pattern)
    const end = performance.now()

    const duration = end - start

    expect(result).toBe(false)
    // In vulnerable versions, this pattern would take effectively forever
    expect(duration).toBeLessThan(100)
  })
})
