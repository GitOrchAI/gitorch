import { describe, expect, it } from 'vitest'
import { generateInitialPipeline } from './generator.js'
import { optimizeExistingPipeline } from './optimizer.js'
import { WorkloadProfile } from '../profiler/index.js'
import { PipelineIR } from '@gitorch/pipeline-core'
import { RiskAssessment } from '../risk-engine/types.js'

describe('Planner', () => {
  describe('Zero-to-One Generation', () => {
    it('generates a pipeline for Node/TS monorepo with Postgres', () => {
      const profile: WorkloadProfile = {
        language: 'typescript',
        runtime: 'node',
        packageManager: 'pnpm',
        isMonorepo: true,
        hasDatabase: true,
        databaseEngine: 'postgres',
        orm: 'prisma',
        dockerfilePresent: false,
        hasMigrations: true,
      }

      const ir = generateInitialPipeline({ profile })

      expect(ir.id).toBe('ci')
      expect(ir.jobs['build-and-test']).toBeDefined()

      const job = ir.jobs['build-and-test']
      const runSteps = job.steps.map((s) => s.run).filter(Boolean)

      expect(runSteps).toContain('pnpm install')
      expect(runSteps).toContain('pnpm run lint')
      expect(runSteps).toContain('pnpm run typecheck')
      expect(runSteps).toContain('pnpm run test')
      expect(runSteps).toContain('pnpm run build')

      expect(job.services?.postgres).toBeDefined()
      expect(job.services?.postgres?.image).toBe('postgres:16-alpine')
    })
  })

  describe('Optimization', () => {
    it('adds secret scan and typecheck to existing pipeline', () => {
      const currentIr: PipelineIR = {
        id: 'ci',
        name: 'CI',
        triggers: [{ type: 'push', branches: ['main'] }],
        jobs: {
          test: {
            id: 'test',
            runsOn: 'ubuntu-latest',
            steps: [
              { uses: 'actions/checkout@v4' },
              { uses: 'actions/setup-node@v4' },
              { run: 'npm ci' },
              { run: 'npm run test' },
            ],
          },
        },
      }

      const assessment: Partial<RiskAssessment> = {
        findings: [],
        missingCapabilities: ['secret-scan', 'typecheck'],
      }

      const optimized = optimizeExistingPipeline({ currentIr, assessment })

      // Should add security-scan job
      expect(optimized.jobs['security-scan']).toBeDefined()
      expect(optimized.jobs['security-scan'].steps[1].uses).toBe('gitleaks/gitleaks-action@v2')

      // Should inject typecheck into the existing test job
      const testJob = optimized.jobs['test']
      const typecheckStep = testJob.steps.find((s) => s.run?.includes('typecheck'))
      expect(typecheckStep).toBeDefined()

      // Check it was inserted before the test step
      const typecheckIndex = testJob.steps.findIndex((s) => s.run?.includes('typecheck'))
      const testIndex = testJob.steps.findIndex((s) => s.run?.includes('npm run test'))
      expect(typecheckIndex).toBeLessThan(testIndex)
    })
  })
})
