import { decideJulesPrGate } from './jules-gate'

test('waits for Jules when CI fails', () => {
  expect(
    decideJulesPrGate({
      prNumber: 10,
      ciConclusion: 'failure',
      qaOnly: 'not-run',
      review: 'not-run',
    })
  ).toEqual({
    decision: 'wait-for-jules-ci-fix',
    mergeAllowed: false,
    comment: undefined,
    requiredActions: ['wait-for-jules-auto-fix-ci'],
  })
})

test('allows merge only when CI, qa-only, review, and scope are complete', () => {
  expect(
    decideJulesPrGate({
      prNumber: 12,
      ciConclusion: 'success',
      qaOnly: 'passed',
      review: 'passed',
    })
  ).toEqual({
    decision: 'merge-ready',
    mergeAllowed: true,
    comment: undefined,
    requiredActions: ['merge-pr'],
  })
})

test('waits for CI when ciConclusion is pending or missing', () => {
  expect(
    decideJulesPrGate({
      prNumber: 13,
      ciConclusion: 'pending',
      qaOnly: 'not-run',
      review: 'not-run',
    })
  ).toEqual({
    decision: 'wait-for-ci',
    mergeAllowed: false,
    requiredActions: ['wait-for-ci'],
  })

  expect(
    decideJulesPrGate({
      prNumber: 14,
      ciConclusion: 'missing',
      qaOnly: 'not-run',
      review: 'not-run',
    })
  ).toEqual({
    decision: 'wait-for-ci',
    mergeAllowed: false,
    requiredActions: ['wait-for-ci'],
  })
})

test('requests running QA/review when qaOnly or review is not-run', () => {
  expect(
    decideJulesPrGate({
      prNumber: 15,
      ciConclusion: 'success',
      qaOnly: 'not-run',
      review: 'passed',
    })
  ).toEqual({
    decision: 'run-qa',
    mergeAllowed: false,
    requiredActions: ['run-qa-only', 'run-review'],
  })

  expect(
    decideJulesPrGate({
      prNumber: 16,
      ciConclusion: 'success',
      qaOnly: 'passed',
      review: 'not-run',
    })
  ).toEqual({
    decision: 'run-qa',
    mergeAllowed: false,
    requiredActions: ['run-qa-only', 'run-review'],
  })
})

test('requests adjustments when qaOnly or review has failed', () => {
  expect(
    decideJulesPrGate({
      prNumber: 17,
      ciConclusion: 'success',
      qaOnly: 'failed',
      review: 'passed',
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #17 is not ready to merge. Required adjustments:\n- Technical review identified missing or incorrect implementations',
    requiredActions: ['comment-on-pr'],
  })

  expect(
    decideJulesPrGate({
      prNumber: 18,
      ciConclusion: 'success',
      qaOnly: 'passed',
      review: 'failed',
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #18 is not ready to merge. Required adjustments:\n- Technical review identified missing or incorrect implementations',
    requiredActions: ['comment-on-pr'],
  })
})

test('uses default message when unmetCriteria is omitted or empty', () => {
  expect(
    decideJulesPrGate({
      prNumber: 19,
      ciConclusion: 'success',
      qaOnly: 'failed',
      review: 'passed',
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #19 is not ready to merge. Required adjustments:\n- Technical review identified missing or incorrect implementations',
    requiredActions: ['comment-on-pr'],
  })

  expect(
    decideJulesPrGate({
      prNumber: 20,
      ciConclusion: 'success',
      qaOnly: 'passed',
      review: 'failed',
      unmetCriteria: [],
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #20 is not ready to merge. Required adjustments:\n- Technical review identified missing or incorrect implementations',
    requiredActions: ['comment-on-pr'],
  })
})

test('provides technical feedback even for large PRs (simulating >35 files)', () => {
  expect(
    decideJulesPrGate({
      prNumber: 21,
      ciConclusion: 'success',
      qaOnly: 'failed',
      review: 'passed',
      unmetCriteria: [
        'Missing unit tests for edge cases',
        'Performance bottleneck in data processing loop'
      ]
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #21 is not ready to merge. Required adjustments:\n- Missing unit tests for edge cases\n- Performance bottleneck in data processing loop',
    requiredActions: ['comment-on-pr'],
  })
})
