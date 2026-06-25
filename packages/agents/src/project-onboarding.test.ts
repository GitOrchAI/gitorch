import { planProjectOnboarding } from './project-onboarding'

test('plans recognition before any task creation for a new project', () => {
  const plan = planProjectOnboarding({
    projectId: 'project-1',
    repository: 'owner/repo',
    hasDocsDirectory: false,
    hasProjectV2: false,
    hasCi: true,
    openIssues: [
      { nodeId: 'I_1', number: 1, title: 'Payments roadmap', type: 'Epic', state: 'open' },
      { nodeId: 'I_2', number: 2, title: 'Stripe checkout', type: 'Feature', state: 'open' },
      { nodeId: 'I_3', number: 3, title: 'Add checkout tests', type: 'Task', state: 'open' },
    ],
    openPullRequests: [{ nodeId: 'PR_4', number: 4, title: 'WIP checkout' }],
    ambiguousSignals: ['No production environment documented'],
  })

  expect(plan.createsProductWork).toBe(false)
  expect(plan.steps.map((step) => step.kind)).toEqual([
    'map-code-graph',
    'prepare-docs',
    'ensure-project-v2',
    'classify-existing-issues',
    'inspect-open-prs',
    'capture-ci-state',
    'ask-owner-question',
    'persist-project-memory',
    'write-repository-docs',
  ])
  expect(plan.ownerQuestions).toEqual([
    {
      id: 'project-1-question-1',
      question: 'No production environment documented',
      options: ['A', 'B', 'C', 'Free form'],
    },
  ])
})

test('reads existing docs instead of preparing docs when repository docs exist', () => {
  const plan = planProjectOnboarding({
    projectId: 'project-2',
    repository: 'owner/docs-ready',
    hasDocsDirectory: true,
    hasProjectV2: true,
    hasCi: false,
    openIssues: [],
    openPullRequests: [],
    ambiguousSignals: [],
  })

  expect(plan.steps.map((step) => step.kind)).toContain('read-docs')
  expect(plan.steps.map((step) => step.kind)).not.toContain('prepare-docs')
})
