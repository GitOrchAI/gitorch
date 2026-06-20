import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

test('audit script writes required CGC report filenames', () => {
  const script = readFileSync('scripts/ci/run-cgc-audit.ts', 'utf8')
  expect(script).toContain('CGC_GRAPH_INCONSISTENCIES.md')
  expect(script).toContain('CGC_CALL_GRAPH_AUDIT_REPORT.md')
  expect(script).toContain('report.callsAuditAccuracy >= report.threshold')
})
