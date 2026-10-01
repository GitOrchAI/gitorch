import { describe, it, expect } from 'vitest'
import { assessPipelineRisks } from './engine.js'
import { PipelineIR } from '@gitorch/pipeline-core'
import { WorkloadProfile } from '../profiler/index.js'

describe('Risk Engine - assessPipelineRisks', () => {
  it('should return score 0 and critical findings when no pipeline exists', () => {
    const profile: WorkloadProfile = {
      language: 'typescript',
      runtime: 'node',
      hasDatabase: false,
      hasMigrations: false,
      isMonorepo: false,
      dockerfilePresent: false,
    }

    const assessment = assessPipelineRisks(null, profile)

    expect(assessment.score).toBe(0)
    expect(assessment.findings.length).toBeGreaterThan(0)
    expect(assessment.findings.some((f) => f.category === 'testing')).toBe(true)
    expect(assessment.findings.some((f) => f.category === 'quality')).toBe(true)
    expect(assessment.findings.some((f) => f.category === 'security')).toBe(true)
    expect(assessment.recommendedStages).toEqual(['Fast CI', 'Preview Environment', 'CD'])
    expect(assessment.missingCapabilities).toContain('testing')
    expect(assessment.missingCapabilities).toContain('quality')
    expect(assessment.missingCapabilities).toContain('security')
  })

  it('should return score 100 for a fully complete CI/CD pipeline', () => {
    const profile: WorkloadProfile = {
      language: 'typescript',
      runtime: 'node',
      hasDatabase: true,
      hasMigrations: true,
      isMonorepo: true,
      dockerfilePresent: true,
      framework: 'next',
    }

    const ir: PipelineIR = {
      id: 'full-ci',
      name: 'Full CI',
      triggers: [{ type: 'push' }],
      jobs: {
        'ci-job': {
          id: 'ci-job',
          runsOn: 'ubuntu-latest',
          services: {
            db: {
              image: 'postgres:14',
            },
          },
          steps: [
            { name: 'Run tests', run: 'pnpm vitest' },
            { name: 'Typecheck', run: 'pnpm tsc' },
            { name: 'Lint', run: 'pnpm eslint' },
            { name: 'Security Scan', run: 'gitleaks detect' },
            { name: 'Migrate DB', run: 'prisma migrate dev' },
            { name: 'Build', run: 'pnpm build' },
          ],
        },
      },
    }

    const assessment = assessPipelineRisks(ir, profile)

    expect(assessment.score).toBe(100)
    expect(assessment.findings.length).toBe(0)
    expect(assessment.recommendedStages).toEqual(['CD'])
    expect(assessment.coveredCapabilities).toContain('testing')
    expect(assessment.coveredCapabilities).toContain('quality')
    expect(assessment.coveredCapabilities).toContain('security')
    expect(assessment.coveredCapabilities).toContain('database')
    expect(assessment.coveredCapabilities).toContain('build')
    expect(assessment.missingCapabilities.length).toBe(0)
  })

  it('should penalize a TypeScript repo with security and DB gaps', () => {
    const profile: WorkloadProfile = {
      language: 'typescript',
      runtime: 'node',
      hasDatabase: true,
      hasMigrations: true,
      isMonorepo: false,
      dockerfilePresent: false,
    }

    const ir: PipelineIR = {
      id: 'partial-ci',
      name: 'Partial CI',
      triggers: [{ type: 'push' }],
      jobs: {
        'ci-job': {
          id: 'ci-job',
          runsOn: 'ubuntu-latest',
          steps: [
            { name: 'Run tests', run: 'pnpm vitest' },
            { name: 'Typecheck', run: 'pnpm tsc' },
            { name: 'Lint', run: 'pnpm eslint' },
            // Missing security scan (-15)
            // Missing DB validation (-15)
          ],
        },
      },
    }

    const assessment = assessPipelineRisks(ir, profile)

    // Expected score: 100 - 15 (security) - 15 (db) = 70
    expect(assessment.score).toBe(70)
    expect(assessment.findings.length).toBe(2)
    expect(assessment.findings.some((f) => f.category === 'security')).toBe(true)
    expect(assessment.findings.some((f) => f.category === 'environment')).toBe(true)

    expect(assessment.coveredCapabilities).toContain('testing')
    expect(assessment.coveredCapabilities).toContain('quality')

    expect(assessment.missingCapabilities).toContain('security')
    expect(assessment.missingCapabilities).toContain('database')
  })
})
