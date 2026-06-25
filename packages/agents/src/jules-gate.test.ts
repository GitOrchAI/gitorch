import { decideJulesPrGate } from './jules-gate'

test('waits for Jules when CI fails', () => {
  expect(
    decideJulesPrGate({
      prNumber: 10,
      ciConclusion: 'failure',
      qaOnly: 'not-run',
      review: 'not-run',
      deliveredScope: 'unknown',
    })
  ).toEqual({
    decision: 'wait-for-jules-ci-fix',
    mergeAllowed: false,
    comment: undefined,
    requiredActions: ['wait-for-jules-auto-fix-ci'],
  })
})

test('comments to Jules when CI is green but scope is incomplete', () => {
  expect(
    decideJulesPrGate({
      prNumber: 11,
      ciConclusion: 'success',
      qaOnly: 'passed',
      review: 'passed',
      deliveredScope: 'incomplete',
      unmetCriteria: ['Verification Criteria #2 missing'],
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #11 is not ready to merge. Required adjustments:\n- Verification Criteria #2 missing',
    requiredActions: ['comment-on-pr'],
  })
})

test('allows merge only when CI, qa-only, review, and scope are complete', () => {
  expect(
    decideJulesPrGate({
      prNumber: 12,
      ciConclusion: 'success',
      qaOnly: 'passed',
      review: 'passed',
      deliveredScope: 'complete',
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
      deliveredScope: 'unknown',
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
      deliveredScope: 'unknown',
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
      deliveredScope: 'complete',
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
      deliveredScope: 'complete',
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
      deliveredScope: 'complete',
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #17 is not ready to merge. Required adjustments:\n- QA/review did not verify 100% of the requested scope',
    requiredActions: ['comment-on-pr'],
  })

  expect(
    decideJulesPrGate({
      prNumber: 18,
      ciConclusion: 'success',
      qaOnly: 'passed',
      review: 'failed',
      deliveredScope: 'complete',
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #18 is not ready to merge. Required adjustments:\n- QA/review did not verify 100% of the requested scope',
    requiredActions: ['comment-on-pr'],
  })
})

test('uses default message when unmetCriteria is omitted or empty', () => {
  expect(
    decideJulesPrGate({
      prNumber: 19,
      ciConclusion: 'success',
      qaOnly: 'passed',
      review: 'passed',
      deliveredScope: 'incomplete',
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #19 is not ready to merge. Required adjustments:\n- QA/review did not verify 100% of the requested scope',
    requiredActions: ['comment-on-pr'],
  })

  expect(
    decideJulesPrGate({
      prNumber: 20,
      ciConclusion: 'success',
      qaOnly: 'passed',
      review: 'passed',
      deliveredScope: 'incomplete',
      unmetCriteria: [],
    })
  ).toEqual({
    decision: 'request-jules-adjustments',
    mergeAllowed: false,
    comment:
      '@jules PR #20 is not ready to merge. Required adjustments:\n- QA/review did not verify 100% of the requested scope',
    requiredActions: ['comment-on-pr'],
  })
})
