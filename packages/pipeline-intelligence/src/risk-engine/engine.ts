import { PipelineIR, PipelineStep } from '@gitorch/pipeline-core'
import { WorkloadProfile } from '../profiler/index.js'
import { RiskAssessment, RiskFinding } from './types.js'

export function assessPipelineRisks(
  ir: PipelineIR | null,
  profile: WorkloadProfile
): RiskAssessment {
  if (ir === null) {
    return {
      score: 0,
      findings: [
        {
          id: 'missing-tests',
          category: 'testing',
          severity: 'critical',
          title: 'Missing Automated Tests',
          description: 'The repository has no CI/CD pipeline configured to run tests.',
          suggestedFix: 'Create a pipeline to run automated tests.',
        },
        {
          id: 'missing-lint',
          category: 'quality',
          severity: 'critical',
          title: 'Missing Code Quality Checks',
          description: 'The repository lacks linting and type checking in CI/CD.',
          suggestedFix: 'Add linting and type checking steps to a pipeline.',
        },
        {
          id: 'missing-security',
          category: 'security',
          severity: 'critical',
          title: 'Missing Security Verifications',
          description: 'No security scans are performed on the codebase.',
          suggestedFix: 'Integrate SAST and secret scanning into a pipeline.',
        },
      ],
      coveredCapabilities: [],
      missingCapabilities: ['testing', 'quality', 'security'],
      recommendedStages: ['Fast CI', 'Preview Environment', 'CD'],
    }
  }

  let penalty = 0
  const findings: RiskFinding[] = []
  const coveredCapabilities: string[] = []
  const missingCapabilities: string[] = []

  let hasTest = false
  let hasTypecheck = false
  let hasLint = false
  let hasSecurity = false
  let hasDbValidation = false
  let hasBuild = false

  const allSteps: PipelineStep[] = []
  const jobValues = Object.values(ir.jobs)

  for (const job of jobValues) {
    if (job.steps) {
      allSteps.push(...job.steps)
    }

    // Check for DB validation via services
    if (profile.hasDatabase && job.services) {
      const services = Object.values(job.services)
      if (
        services.some(
          (s) =>
            s.image.includes('postgres') || s.image.includes('mysql') || s.image.includes('redis')
        )
      ) {
        hasDbValidation = true
      }
    }
  }

  for (const step of allSteps) {
    const run = (step.run || '').toLowerCase()
    const name = (step.name || '').toLowerCase()
    const uses = (step.uses || '').toLowerCase()

    const cmd = run + ' ' + name + ' ' + uses

    if (
      cmd.includes('test') ||
      cmd.includes('vitest') ||
      cmd.includes('jest') ||
      cmd.includes('pytest') ||
      cmd.includes('playwright')
    ) {
      hasTest = true
    }

    if (cmd.includes('typecheck') || cmd.includes('tsc')) {
      hasTypecheck = true
    }

    if (cmd.includes('eslint') || cmd.includes('lint')) {
      hasLint = true
    }

    if (
      cmd.includes('gitleaks') ||
      cmd.includes('trufflehog') ||
      cmd.includes('semgrep') ||
      cmd.includes('codeql')
    ) {
      hasSecurity = true
    }

    if (profile.hasDatabase) {
      if (
        cmd.includes('migrate') ||
        cmd.includes('db push') ||
        cmd.includes('db:push') ||
        cmd.includes('migration')
      ) {
        hasDbValidation = true
      }
    }

    if (cmd.includes('build')) {
      hasBuild = true
    }
  }

  if (!hasTest) {
    penalty += 30
    findings.push({
      id: 'missing-test-step',
      category: 'testing',
      severity: 'critical',
      title: 'Missing Test Execution',
      description: 'The pipeline does not seem to run any tests.',
      suggestedFix: 'Add a step to run automated tests.',
    })
    missingCapabilities.push('testing')
  } else {
    coveredCapabilities.push('testing')
  }

  if (profile.language === 'typescript' && !hasTypecheck) {
    penalty += 15
    findings.push({
      id: 'missing-typecheck-step',
      category: 'quality',
      severity: 'high',
      title: 'Missing Type Checking',
      description: 'The pipeline for this TypeScript project does not run type checking.',
      suggestedFix: 'Add a step to run type checking (e.g. tsc).',
    })
    if (!missingCapabilities.includes('quality')) missingCapabilities.push('quality')
  } else if (profile.language === 'typescript' && hasTypecheck) {
    if (!coveredCapabilities.includes('quality')) coveredCapabilities.push('quality')
  }

  if (!hasLint) {
    penalty += 10
    findings.push({
      id: 'missing-lint-step',
      category: 'quality',
      severity: 'medium',
      title: 'Missing Linting',
      description: 'The pipeline does not seem to run linting.',
      suggestedFix: 'Add a step to run a linter like ESLint.',
    })
    if (!missingCapabilities.includes('quality')) missingCapabilities.push('quality')
  } else {
    if (!coveredCapabilities.includes('quality')) coveredCapabilities.push('quality')
  }

  if (!hasSecurity) {
    penalty += 15
    findings.push({
      id: 'missing-security-step',
      category: 'security',
      severity: 'high',
      title: 'Missing Security Scans',
      description: 'The pipeline does not include security scanning tools.',
      suggestedFix: 'Add a security scan step (e.g., CodeQL, TruffleHog).',
    })
    missingCapabilities.push('security')
  } else {
    coveredCapabilities.push('security')
  }

  if (profile.hasDatabase && !hasDbValidation) {
    penalty += 15
    findings.push({
      id: 'missing-db-validation',
      category: 'environment',
      severity: 'high',
      title: 'Missing Database/Migrations Validation',
      description:
        'The project uses a database but the pipeline does not validate migrations or use a DB service.',
      suggestedFix: 'Add database service containers and run migrations in CI.',
    })
    missingCapabilities.push('database')
  } else if (profile.hasDatabase && hasDbValidation) {
    coveredCapabilities.push('database')
  }

  if ((profile.isMonorepo || profile.framework) && !hasBuild) {
    penalty += 10
    findings.push({
      id: 'missing-build-step',
      category: 'quality',
      severity: 'medium',
      title: 'Missing Build Step',
      description: 'The project appears to require a build step, but none was found.',
      suggestedFix: 'Add a step to build the project.',
    })
    if (!missingCapabilities.includes('build')) missingCapabilities.push('build')
  } else if ((profile.isMonorepo || profile.framework) && hasBuild) {
    if (!coveredCapabilities.includes('build')) coveredCapabilities.push('build')
  }

  const score = Math.max(0, 100 - penalty)

  let recommendedStages: string[] = []
  if (score < 50) {
    recommendedStages = ['Fast CI', 'Preview Environment', 'CD']
  } else if (score < 80) {
    recommendedStages = ['Preview Environment', 'CD']
  } else if (score <= 100) {
    recommendedStages = ['CD']
  }

  return {
    score,
    findings,
    coveredCapabilities,
    missingCapabilities,
    recommendedStages,
  }
}
