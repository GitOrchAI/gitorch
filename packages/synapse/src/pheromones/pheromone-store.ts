import type { PheromoneMark, SynapseActor, SynapseScope } from '../types'
import { PheromonePolicy } from './pheromone-policy'

export interface CreatePheromoneInput {
  type: PheromoneMark['type']
  scope: SynapseScope
  owner: SynapseActor
  reason: string
  metadata: Record<string, unknown>
  now: string
  strength?: number
  sourceEventId?: string
}

export class InMemoryPheromoneStore {
  private readonly marks: PheromoneMark[] = []
  private readonly policy = new PheromonePolicy()
  private nextId = 1

  create(input: CreatePheromoneInput): PheromoneMark {
    const mark: PheromoneMark = this.policy.apply({
      id: `ph-${this.nextId++}`,
      type: input.type,
      scope: cloneScope(input.scope),
      owner: cloneActor(input.owner),
      strength: input.strength ?? 1,
      createdAt: input.now,
      updatedAt: input.now,
      reason: input.reason,
      metadata: cloneMetadata(input.metadata),
      sourceEventId: input.sourceEventId,
    })

    for (const existing of this.marks) {
      if (this.policy.conflicts(existing, mark, input.now)) {
        throw new Error('Pheromone conflict: active blocking mark from a competing owner')
      }
    }

    this.marks.push(mark)
    return cloneMark(mark)
  }

  activeForScope(scope: SynapseScope, now: string): PheromoneMark[] {
    return this.marks
      .filter((mark) => sameScope(mark.scope, scope))
      .map((mark) => this.policy.decay(mark, now))
      .filter((mark): mark is PheromoneMark => mark !== null)
      .map((mark) => cloneMark(mark))
  }

  decayAll(now: string): PheromoneMark[] {
    return this.marks
      .map((mark) => this.policy.decay(mark, now))
      .filter((mark): mark is PheromoneMark => mark !== null)
      .map((mark) => cloneMark(mark))
  }

  expireByMetadata(key: string, value: string, now: string): number {
    let expired = 0

    for (const mark of this.marks) {
      if (mark.metadata[key] !== value) {
        continue
      }

      mark.expiresAt = now
      mark.updatedAt = now
      expired += 1
    }

    return expired
  }

  history(): PheromoneMark[] {
    return this.marks.map((mark) => cloneMark(mark))
  }
}

function sameScope(left: SynapseScope, right: SynapseScope): boolean {
  return (
    left.type === right.type && left.wingId === right.wingId && left.targetId === right.targetId
  )
}

function cloneMark(mark: PheromoneMark): PheromoneMark {
  return {
    ...mark,
    scope: cloneScope(mark.scope),
    owner: cloneActor(mark.owner),
    metadata: cloneMetadata(mark.metadata),
  }
}

function cloneScope(scope: SynapseScope): SynapseScope {
  return { ...scope }
}

function cloneActor(actor: SynapseActor): SynapseActor {
  return { ...actor }
}

function cloneMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(metadata)) as Record<string, unknown>
}
