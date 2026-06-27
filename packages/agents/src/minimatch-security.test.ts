import { describe, it, expect } from 'vitest';
import { minimatch } from 'minimatch';

describe('minimatch ReDoS security', () => {
  it('should be resilient to catastrophic backtracking (ReDoS) with many asterisks', () => {
    const pattern = '*'.repeat(100) + 'X' + '*'.repeat(10);
    const testString = 'a'.repeat(50);

    const start = Date.now();
    const result = minimatch(testString, pattern);
    const duration = Date.now() - start;

    expect(result).toBe(false);
    // Even on slow CI, 100ms is plenty for a non-vulnerable version.
    // Vulnerable versions would take seconds or minutes.
    expect(duration).toBeLessThan(100);
  });

  it('should handle nested extglobs without exponential performance degradation', () => {
    // This is another common ReDoS vector in glob libraries
    const pattern = '@(a|@(b|c))'.repeat(20) + 'X';
    const testString = 'a'.repeat(20);

    const start = Date.now();
    const result = minimatch(testString, pattern);
    const duration = Date.now() - start;

    expect(result).toBe(false);
    expect(duration).toBeLessThan(100);
  });
});
