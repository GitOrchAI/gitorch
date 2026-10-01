import { PipelineIR, PipelineJob } from '@gitorch/pipeline-core'
import { GenerationOptions } from './types.js'

export function generateInitialPipeline(options: GenerationOptions): PipelineIR {
  const { profile, runner, defaultBranch } = options

  const runnerRequirement = runner || { type: 'hosted', os: 'ubuntu-latest' }
  const mainBranch = defaultBranch || 'main'

  const ir: PipelineIR = {
    id: 'ci',
    name: 'CI',
    triggers: [
      { type: 'push', branches: [mainBranch] },
      { type: 'pull_request', branches: [mainBranch] },
    ],
    runnerRequirements: runnerRequirement,
    jobs: {},
  }

  const defaultRunsOn = runnerRequirement.os

  if (
    profile.runtime === 'node' ||
    profile.language === 'typescript' ||
    profile.language === 'javascript'
  ) {
    const job: PipelineJob = {
      id: 'build-and-test',
      name: 'Build and Test',
      runsOn: defaultRunsOn,
      steps: [
        { uses: 'actions/checkout@v4' },
        { uses: 'actions/setup-node@v4', with: { 'node-version': '20' } },
      ],
    }

    const pm = profile.packageManager || 'npm'

    // Install step
    if (pm === 'pnpm') {
      job.steps.push({ uses: 'pnpm/action-setup@v4', with: { version: '9' } })
      job.steps.push({ run: 'pnpm install' })
    } else if (pm === 'yarn') {
      job.steps.push({ run: 'yarn install' })
    } else {
      job.steps.push({ run: 'npm ci' })
    }

    // Lint
    job.steps.push({ run: `${pm} run lint` })

    // Typecheck
    if (profile.language === 'typescript') {
      job.steps.push({ run: `${pm} run typecheck` })
    }

    // Test
    job.steps.push({ run: `${pm} run test` })

    // Build
    job.steps.push({ run: `${pm} run build` })

    // Database services
    if (profile.hasDatabase && profile.databaseEngine === 'postgres') {
      job.services = {
        postgres: {
          image: 'postgres:16-alpine',
          ports: ['5432:5432'],
          env: {
            POSTGRES_USER: 'testuser',
            POSTGRES_PASSWORD: 'testpassword',
            POSTGRES_DB: 'testdb',
          },
        },
      }
    }

    ir.jobs['build-and-test'] = job
  } else if (profile.runtime === 'python' || profile.language === 'python') {
    const job: PipelineJob = {
      id: 'test',
      name: 'Test',
      runsOn: defaultRunsOn,
      steps: [
        { uses: 'actions/checkout@v4' },
        { uses: 'actions/setup-python@v5', with: { 'python-version': '3.12' } },
        { run: 'pip install -r requirements.txt' },
        { run: 'pytest' },
      ],
    }
    ir.jobs['test'] = job
  }

  if (profile.dockerfilePresent) {
    // If no other jobs, create a dedicated docker build job
    if (Object.keys(ir.jobs).length === 0) {
      ir.jobs['docker-build'] = {
        id: 'docker-build',
        name: 'Docker Build',
        runsOn: defaultRunsOn,
        steps: [{ uses: 'actions/checkout@v4' }, { run: 'docker build .' }],
      }
    } else {
      // Add a step to the existing main job (e.g. build-and-test)
      const mainJobId = Object.keys(ir.jobs)[0]
      ir.jobs[mainJobId].steps.push({ run: 'docker build .' })
    }
  }

  return ir
}
