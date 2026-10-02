import { PipelineIR, PipelineJob } from '@gitorch/pipeline-core'
import { OptimizationOptions } from './types.js'

export function optimizeExistingPipeline(options: OptimizationOptions): PipelineIR {
  const { currentIr, assessment, runner } = options

  // Clone to avoid mutating original
  const ir = JSON.parse(JSON.stringify(currentIr)) as PipelineIR

  const defaultRunsOn = runner?.os || ir.runnerRequirements?.os || 'ubuntu-latest'
  const jobIds = Object.keys(ir.jobs)

  let mainTestJob: PipelineJob | undefined
  // Simple heuristic: find a job with "test" in the name or ID
  for (const jobId of jobIds) {
    if (
      jobId.toLowerCase().includes('test') ||
      ir.jobs[jobId].name?.toLowerCase().includes('test')
    ) {
      mainTestJob = ir.jobs[jobId]
      break
    }
  }
  // If no obvious test job, pick the first one
  if (!mainTestJob && jobIds.length > 0) {
    mainTestJob = ir.jobs[jobIds[0]]
  }

  for (const missing of assessment.missingCapabilities || []) {
    if (missing === 'secret-scan') {
      ir.jobs['security-scan'] = {
        id: 'security-scan',
        name: 'Security Scan',
        runsOn: defaultRunsOn,
        steps: [
          { uses: 'actions/checkout@v4', with: { 'fetch-depth': 0 } },
          {
            uses: 'gitleaks/gitleaks-action@v2',
            env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' },
          },
        ],
      }
    } else if (missing === 'typecheck') {
      if (mainTestJob) {
        // Find PM from steps (very simple heuristic)
        let pm = 'npm'
        const steps = mainTestJob.steps
        for (const step of steps) {
          if (step.run && step.run.includes('pnpm ')) pm = 'pnpm'
          else if (step.run && step.run.includes('yarn ')) pm = 'yarn'
        }

        // Find install/setup step index to insert typecheck before tests or after setup
        let insertIdx = steps.length
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i]
          if (step.run && (step.run.includes('test') || step.run.includes('build'))) {
            insertIdx = i
            break
          }
        }

        mainTestJob.steps.splice(insertIdx, 0, { run: `${pm} run typecheck` })
      } else {
        // Create new typecheck job if no main job found
        ir.jobs['typecheck'] = {
          id: 'typecheck',
          name: 'Typecheck',
          runsOn: defaultRunsOn,
          steps: [
            { uses: 'actions/checkout@v4' },
            { uses: 'actions/setup-node@v4', with: { 'node-version': '20' } },
            { run: 'npm ci' },
            { run: 'npm run typecheck' },
          ],
        }
      }
    } else if (missing === 'database-service') {
      // Inject into main test job
      if (mainTestJob) {
        if (!mainTestJob.services) {
          mainTestJob.services = {}
        }
        if (!mainTestJob.services.postgres) {
          mainTestJob.services.postgres = {
            image: 'postgres:16-alpine',
            ports: ['5432:5432'],
            env: {
              POSTGRES_USER: 'testuser',
              POSTGRES_PASSWORD: 'testpassword',
              POSTGRES_DB: 'testdb',
            },
          }
        }
      }
    }
  }

  // Also check findings if there's overlap in definitions
  for (const finding of assessment.findings || []) {
    if (
      finding.type === 'missing_capability' &&
      finding.id === 'secret-scan' &&
      !(assessment.missingCapabilities || []).includes('secret-scan')
    ) {
      // Could duplicate, but in this case missingCapabilities should contain it.
      // Doing nothing extra here to avoid duplicates.
    }
  }

  return ir
}
