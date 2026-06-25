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
