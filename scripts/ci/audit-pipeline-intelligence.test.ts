import { describe, it, expect } from 'vitest'
import { runPipelineAudit } from './audit-pipeline-intelligence.js'

describe('Pipeline Intelligence CI Audit Gate', () => {
  it('should audit GitOrch CI pipeline and score compliant (score >= 80)', () => {
    const report = runPipelineAudit()
    expect(report.score).toBeGreaterThanOrEqual(80)
    expect(report.compliant).toBe(true)
    expect(report.coveredCapabilities).toContain('testing')
    expect(report.coveredCapabilities).toContain('quality')
    expect(report.coveredCapabilities).toContain('security')
    expect(report.coveredCapabilities).toContain('database')
    expect(report.coveredCapabilities).toContain('build')
  })
})
