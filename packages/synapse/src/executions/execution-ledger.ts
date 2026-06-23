import type { ExecutionRecord, NextActionDecision, SynapseActor, SynapseScope } from '../types'

export interface StartExecutionInput {
  agent: SynapseActor
  scope: SynapseScope
  scheduledFor: string
  actionKey: string
  now: string
}

export interface CompleteExecutionInput {
  completedAt: string
  summary: string
  evidenceRefs: string[]
  nextCandidateActions: string[]
}

export class ExecutionLedger {
  private readonly records: ExecutionRecord[] = []
  private nextId = 1

  start(input: StartExecutionInput): ExecutionRecord {
    const record: ExecutionRecord = {
      id: `run-${this.nextId++}`,
      agent: cloneActor(input.agent),
      scope: cloneScope(input.scope),
      scheduledFor: input.scheduledFor,
      startedAt: input.now,
      status: 'started',
      actionKey: input.actionKey,
      summary: '',
      evidenceRefs: [],
      nextCandidateActions: [],
    }

    this.records.push(record)
    return cloneRecord(record)
  }

  complete(recordId: string, input: CompleteExecutionInput): ExecutionRecord {
    const record = this.records.find((entry) => entry.id === recordId)

    if (!record) {
      throw new Error(`Execution record not found: ${recordId}`)
    }

    record.status = 'completed'
    record.completedAt = input.completedAt
    record.summary = input.summary
    record.evidenceRefs = [...input.evidenceRefs]
    record.nextCandidateActions = [...input.nextCandidateActions]

    return cloneRecord(record)
  }

  historyForAgent(agent: SynapseActor, scope: SynapseScope): ExecutionRecord[] {
    return this.records
      .filter((record) => record.agent.id === agent.id && sameScope(record.scope, scope))
      .map((record) => cloneRecord(record))
  }

  chooseNextAction(
    agent: SynapseActor,
    scope: SynapseScope,
    candidateActions: string[]
  ): NextActionDecision {
    const completedActions = new Set(
      this.historyForAgent(agent, scope)
        .filter((record) => record.status === 'completed')
        .map((record) => record.actionKey)
    )

    let skipped = 0
    for (const actionKey of candidateActions) {
      if (completedActions.has(actionKey)) {
        skipped++
        continue
      }

      return {
        actionKey,
        reason: `Skipped ${skipped} previously completed action${skipped === 1 ? '' : 's'} for this agent and scope.`,
        repeated: false,
      }
    }

    return {
      actionKey: candidateActions[0] ?? 'no-action',
      reason:
        candidateActions.length === 0
          ? 'No candidate actions available for this agent and scope.'
          : 'All candidate actions were previously completed for this agent and scope.',
      repeated: true,
    }
  }
}

function sameScope(left: SynapseScope, right: SynapseScope): boolean {
  return (
    left.type === right.type && left.wingId === right.wingId && left.targetId === right.targetId
  )
}

function cloneRecord(record: ExecutionRecord): ExecutionRecord {
  return {
    ...record,
    agent: cloneActor(record.agent),
    scope: cloneScope(record.scope),
    evidenceRefs: [...record.evidenceRefs],
    nextCandidateActions: [...record.nextCandidateActions],
  }
}

function cloneActor(actor: SynapseActor): SynapseActor {
  return { ...actor }
}

function cloneScope(scope: SynapseScope): SynapseScope {
  return { ...scope }
}
