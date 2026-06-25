import type {
  CiConclusion,
  DeliveredScopeResult,
  GateCheckResult,
  JulesPrGateResult,
} from './types'

export interface DecideJulesPrGateInput {
  prNumber: number
  ciConclusion: CiConclusion
  qaOnly: GateCheckResult
  review: GateCheckResult
  deliveredScope: DeliveredScopeResult
  unmetCriteria?: string[]
}

export function decideJulesPrGate(input: DecideJulesPrGateInput): JulesPrGateResult {
  if (input.ciConclusion === 'pending' || input.ciConclusion === 'missing') {
    return {
      decision: 'wait-for-ci',
      mergeAllowed: false,
      requiredActions: ['wait-for-ci'],
    }
  }

  if (input.ciConclusion === 'failure') {
    return {
      decision: 'wait-for-jules-ci-fix',
      mergeAllowed: false,
      requiredActions: ['wait-for-jules-auto-fix-ci'],
    }
  }

  if (input.qaOnly === 'not-run' || input.review === 'not-run') {
    return {
      decision: 'run-qa',
      mergeAllowed: false,
      requiredActions: ['run-qa-only', 'run-review'],
    }
  }

  if (
    input.qaOnly === 'failed' ||
    input.review === 'failed' ||
    input.deliveredScope !== 'complete'
  ) {
    const unmetCriteria = input.unmetCriteria?.length
      ? input.unmetCriteria
      : ['QA/review did not verify 100% of the requested scope']

    return {
      decision: 'request-jules-adjustments',
      mergeAllowed: false,
      comment: buildJulesAdjustmentComment(input.prNumber, unmetCriteria),
      requiredActions: ['comment-on-pr'],
    }
  }

  return {
    decision: 'merge-ready',
    mergeAllowed: true,
    requiredActions: ['merge-pr'],
  }
}

function buildJulesAdjustmentComment(prNumber: number, unmetCriteria: string[]): string {
  return [
    `@jules PR #${prNumber} is not ready to merge. Required adjustments:`,
    ...unmetCriteria.map((criterion) => `- ${criterion}`),
  ].join('\n')
}
