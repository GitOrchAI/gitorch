import type { PheromoneMark, PheromoneType } from '../types'

const EXPIRY_MINUTES: Partial<Record<PheromoneType, number>> = {
  exploring: 2,
  claiming: 60,
  modifying: 10,
  completed: 1440,
  blocked: 5,
}

const BLOCKING_TYPES = new Set<PheromoneType>(['claiming', 'modifying', 'warning'])

export function addMinutes(value: string, minutes: number): string {
  const date = new Date(value)
  date.setUTCMinutes(date.getUTCMinutes() + minutes)
  return date.toISOString()
}

export class PheromonePolicy {
  apply(mark: PheromoneMark): PheromoneMark {
    return this.withExpiry(mark)
  }

  withExpiry(mark: PheromoneMark): PheromoneMark {
    if (mark.expiresAt || mark.type === 'warning') {
      return { ...mark }
    }

    const minutes = EXPIRY_MINUTES[mark.type]
    if (minutes === undefined) {
      return { ...mark }
    }

    return {
      ...mark,
      expiresAt: addMinutes(mark.createdAt, minutes),
    }
  }

  decay(mark: PheromoneMark, now: string): PheromoneMark | null {
    if (mark.type === 'warning') {
      return { ...mark }
    }

    const hydrated = this.withExpiry(mark)
    if (!hydrated.expiresAt) {
      return hydrated
    }

    return new Date(now).getTime() >= new Date(hydrated.expiresAt).getTime() ? null : hydrated
  }

  conflicts(existing: PheromoneMark, incoming: PheromoneMark, now: string): boolean {
    const activeExisting = this.decay(existing, now)
    if (!activeExisting) {
      return false
    }

    if (!BLOCKING_TYPES.has(activeExisting.type)) {
      return false
    }

    if (!BLOCKING_TYPES.has(incoming.type)) {
      return false
    }

    return (
      activeExisting.owner.id !== incoming.owner.id &&
      activeExisting.scope.type === incoming.scope.type &&
      activeExisting.scope.wingId === incoming.scope.wingId &&
      activeExisting.scope.targetId === incoming.scope.targetId
    )
  }
}
