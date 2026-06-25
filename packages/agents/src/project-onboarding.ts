import type { GitHubIssueType, GitHubWorkState } from '@gitorch/github-sync'
import type { OnboardingStep, OwnerQuestion, ProjectOnboardingPlan } from './types'

export interface OnboardingIssueSnapshot {
  nodeId: string
  number: number
  title: string
  type: GitHubIssueType
  state: GitHubWorkState
}

export interface OnboardingPullRequestSnapshot {
  nodeId: string
  number: number
  title: string
}

export interface PlanProjectOnboardingInput {
  projectId: string
  repository: string
  hasDocsDirectory: boolean
  hasProjectV2: boolean
  hasCi: boolean
  openIssues: OnboardingIssueSnapshot[]
  openPullRequests: OnboardingPullRequestSnapshot[]
  ambiguousSignals: string[]
}

export function planProjectOnboarding(input: PlanProjectOnboardingInput): ProjectOnboardingPlan {
  const steps: OnboardingStep[] = [
    step('map-code-graph', `Map ${input.repository} with CodeSight/CGC before planning work.`),
    input.hasDocsDirectory
      ? step('read-docs', 'Read existing repository docs and treat them as project evidence.')
      : step('prepare-docs', 'Prepare initial repository docs because no docs directory exists.'),
  ]

  if (!input.hasProjectV2 || input.openIssues.length > 0) {
    steps.push(
      step(
        'ensure-project-v2',
        'Ensure existing GitHub issues are represented in Projects V2 before agent execution.'
      )
    )
  }

  steps.push(
    step(
      'classify-existing-issues',
      `Classify ${input.openIssues.length} open issues as Epic, Feature, or Task without creating product work.`
    ),
    step(
      'inspect-open-prs',
      `Inspect ${input.openPullRequests.length} open pull requests and link them to existing work when possible.`
    ),
    step(
      'capture-ci-state',
      input.hasCi
        ? 'Capture existing CI workflows and checks.'
        : 'Record that no CI workflow was detected.'
    )
  )

  const ownerQuestions = input.ambiguousSignals.map<OwnerQuestion>((question, index) => ({
    id: `${input.projectId}-question-${index + 1}`,
    question,
    options: ['A', 'B', 'C', 'Free form'],
  }))

  if (ownerQuestions.length > 0) {
    steps.push(
      step(
        'ask-owner-question',
        'Ask only the project questions that cannot be answered from code, docs, GitHub, or CI.'
      )
    )
  }

  steps.push(
    step('persist-project-memory', 'Persist project understanding into GitOrch project memory.'),
    step(
      'write-repository-docs',
      'Write project understanding into repository docs by architecture, structure, and workflows.'
    )
  )

  return {
    projectId: input.projectId,
    repository: input.repository,
    createsProductWork: false,
    steps,
    ownerQuestions,
  }
}

function step(kind: OnboardingStep['kind'], summary: string): OnboardingStep {
  return { kind, summary, evidenceRefs: [] }
}
