import type { DecisionBrief, DecisionOption, SynapseActor, SynapseScope } from '../types'

export interface RequestDecisionBriefInput {
  scope: SynapseScope
  requestedBy: SynapseActor
  question: string
  options: DecisionOption[]
  now: string
}

export class DecisionBriefService {
  private readonly briefs: DecisionBrief[] = []
  private nextId = 1

  request(input: RequestDecisionBriefInput): DecisionBrief {
    if (input.options.length < 2) {
      throw new Error('Decision briefs require at least two options.')
    }

    const brief: DecisionBrief = {
      id: `decision-brief-${this.nextId++}`,
      scope: cloneScope(input.scope),
      requestedBy: cloneActor(input.requestedBy),
      status: 'open',
      question: input.question,
      options: input.options.map(cloneOption),
      createdAt: input.now,
    }

    this.briefs.push(brief)
    return cloneBrief(brief)
  }

  answer(briefId: string, answerId: string, now: string): DecisionBrief {
    const brief = this.briefs.find((entry) => entry.id === briefId)

    if (!brief) {
      throw new Error(`Decision brief not found: ${briefId}`)
    }

    const option = brief.options.find((entry) => entry.id === answerId)
    if (!option) {
      throw new Error(`Decision option not found: ${answerId}`)
    }

    brief.status = 'answered'
    brief.answeredAt = now
    brief.answerId = option.id

    return cloneBrief(brief)
  }

  open(): DecisionBrief[] {
    return this.briefs.filter((brief) => brief.status === 'open').map((brief) => cloneBrief(brief))
  }
}

function cloneBrief(brief: DecisionBrief): DecisionBrief {
  return {
    ...brief,
    scope: cloneScope(brief.scope),
    requestedBy: cloneActor(brief.requestedBy),
    options: brief.options.map(cloneOption),
  }
}

function cloneScope(scope: SynapseScope): SynapseScope {
  return { ...scope }
}

function cloneActor(actor: SynapseActor): SynapseActor {
  return { ...actor }
}

function cloneOption(option: DecisionOption): DecisionOption {
  return { ...option }
}
