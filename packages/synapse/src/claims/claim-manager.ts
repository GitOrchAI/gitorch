import type { ClaimLease, SynapseActor, SynapseScope } from '../types'
import type { InMemoryPheromoneStore } from '../pheromones/pheromone-store'

export interface AcquireClaimInput {
  scope: SynapseScope
  owner: SynapseActor
  reason: string
  now: string
}

export interface AcquireClaimResult {
  acquired: boolean
  lease?: ClaimLease
  blockedBy?: ClaimLease
}

const LEASE_DURATION_MINUTES = 60

export class ClaimManager {
  private readonly leases = new Map<string, ClaimLease>()
  private nextId = 1

  constructor(private readonly store: InMemoryPheromoneStore) {
    void this.store
  }

  acquire(input: AcquireClaimInput): AcquireClaimResult {
    this.removeExpiredLeases(input.now)

    const activeLease = this.activeLeaseForScope(input.scope, input.now)
    if (activeLease && activeLease.owner.id !== input.owner.id) {
      return {
        acquired: false,
        blockedBy: activeLease,
      }
    }

    if (activeLease) {
      const storedLease = this.leases.get(activeLease.id)
      if (storedLease) {
        storedLease.acquiredAt = input.now
        storedLease.expiresAt = addMinutes(input.now, LEASE_DURATION_MINUTES)
        storedLease.reason = input.reason
        this.createClaimingPheromone(input, storedLease.id)
        return {
          acquired: true,
          lease: cloneLease(storedLease),
        }
      }
    }

    const lease: ClaimLease = {
      id: `claim-${this.nextId++}`,
      scope: cloneScope(input.scope),
      owner: cloneActor(input.owner),
      acquiredAt: input.now,
      expiresAt: addMinutes(input.now, LEASE_DURATION_MINUTES),
      reason: input.reason,
    }

    this.leases.set(lease.id, lease)
    this.createClaimingPheromone(input, lease.id)

    return {
      acquired: true,
      lease: cloneLease(lease),
    }
  }

  release(leaseId: string, now = new Date().toISOString()): boolean {
    const released = this.leases.delete(leaseId)
    if (released) {
      this.store.expireByMetadata('leaseId', leaseId, now)
    }

    return released
  }

  activeLeaseForScope(scope: SynapseScope, now: string): ClaimLease | undefined {
    this.removeExpiredLeases(now)

    let activeLease: ClaimLease | undefined
    for (const lease of this.leases.values()) {
      if (!sameScope(lease.scope, scope)) {
        continue
      }

      if (!activeLease || isLater(lease.acquiredAt, activeLease.acquiredAt)) {
        activeLease = lease
      }
    }

    return activeLease ? cloneLease(activeLease) : undefined
  }

  private removeExpiredLeases(now: string): void {
    for (const [leaseId, lease] of this.leases.entries()) {
      if (isExpired(lease.expiresAt, now)) {
        this.leases.delete(leaseId)
      }
    }
  }

  private createClaimingPheromone(input: AcquireClaimInput, leaseId: string): void {
    this.store.create({
      type: 'claiming',
      scope: input.scope,
      owner: input.owner,
      reason: input.reason,
      metadata: { leaseId },
      now: input.now,
    })
  }
}

function addMinutes(value: string, minutes: number): string {
  const date = new Date(value)
  date.setUTCMinutes(date.getUTCMinutes() + minutes)
  return date.toISOString()
}

function isExpired(expiresAt: string, now: string): boolean {
  return new Date(now).getTime() >= new Date(expiresAt).getTime()
}

function isLater(left: string, right: string): boolean {
  return new Date(left).getTime() > new Date(right).getTime()
}

function sameScope(left: SynapseScope, right: SynapseScope): boolean {
  return (
    left.type === right.type && left.wingId === right.wingId && left.targetId === right.targetId
  )
}

function cloneLease(lease: ClaimLease): ClaimLease {
  return {
    ...lease,
    scope: cloneScope(lease.scope),
    owner: cloneActor(lease.owner),
  }
}

function cloneScope(scope: SynapseScope): SynapseScope {
  return { ...scope }
}

function cloneActor(actor: SynapseActor): SynapseActor {
  return { ...actor }
}
