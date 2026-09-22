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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JulesApiAction = (...args: any[]) => Promise<any>

export function wrapWithJulesGate<T extends JulesApiAction>(
  action: T,
  julesApiKey: string | undefined
): T {
  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    if (!julesApiKey) {
      throw Object.assign(new Error('Jules API key is missing.'), { code: 'INTERNAL' })
    }

    try {
      return await action(...args)
    } catch (err: unknown) {
      const error = err as { status?: number }
      if (error && error.status === 429) {
        throw Object.assign(
          new Error('Limite de requisições da API do Jules excedido ou cota esgotada.'),
          { code: 'RATE_LIMITED' }
        )
      }
      throw err
    }
  }) as T
}
