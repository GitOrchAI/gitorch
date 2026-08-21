import { describe, it, expect } from 'vitest'
import { minimatch, Minimatch } from 'minimatch'
import { expand } from 'brace-expansion'

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

describe('Brace Expansion Security (CVE-2026-14257)', () => {
  it('should handle large brace expansion safely without causing process crash (OOM)', () => {
    // Input that used to crash vulnerable versions (< 5.0.8) with an uncatchable Out-Of-Memory error
    const N = 1500
    const input = '{a,b}'.repeat(N)

    // Fixed in 5.0.8 with TWO caps, not one. `EXPANSION_MAX` (100_000
    // results) alone is not the fix: 100_000 results of ~1_500 characters
    // each is still enough memory to lose control before the final
    // truncation — the exact gap CVE-2026-14257 closes. The second cap,
    // `EXPANSION_MAX_LENGTH` (4_000_000 accumulated characters), is what
    // actually stops THIS input, and it stops it far below the 100_000
    // count cap. Asserting on the OUTPUT (below) proves both caps are live;
    // asserting on WALL-CLOCK TIME does not — measured 0/10 failures idle
    // and 10/10 failures under 4x CPU load on a shared CI runner (the
    // instrument was flaky, not the fix). The size of the result does not
    // change with machine load.
    const result = expand(input)

    expect(Array.isArray(result)).toBe(true)
    // The original security guarantee — untouched, still the ceiling that
    // must never be crossed regardless of which cap enforces it.
    expect(result.length).toBeLessThanOrEqual(100000)
    // Tighter and load-independent: proves the CHARACTER-length cap is what
    // actually bounded this specific input, not just the count cap. A "fix"
    // that kept only `EXPANSION_MAX` (count) and dropped
    // `EXPANSION_MAX_LENGTH` would still pass the assertion above (it would
    // produce exactly 100_000 results) but fails this one.
    expect(result.length).toBeLessThan(10_000)
    // Every surviving result is a COMPLETE expansion (one character kept per
    // repeated group) — the cut is in how MANY results survive, never in
    // truncating a result mid-string.
    expect(result.every((s) => s.length === N)).toBe(true)
  })
})
