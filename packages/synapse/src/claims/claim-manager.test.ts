import { expect, test } from 'vitest'
import { ClaimManager } from './claim-manager'
import { InMemoryPheromoneStore } from '../pheromones/pheromone-store'

const scope = { type: 'issue' as const, wingId: 'loureng/gitorch', targetId: '42' }
const sm = { id: 'sm', role: 'sm' as const }
const qa = { id: 'qa', role: 'qa' as const }

test('rejects competing claims until lease expires', () => {
  const store = new InMemoryPheromoneStore()
  const manager = new ClaimManager(store)

  const first = manager.acquire({
    scope,
    owner: sm,
    reason: 'SM is planning task',
    now: '2026-06-22T10:00:00.000Z',
  })

  expect(first.acquired).toBe(true)

  const second = manager.acquire({
    scope,
    owner: qa,
    reason: 'QA wants same task',
    now: '2026-06-22T10:05:00.000Z',
  })

  expect(second.acquired).toBe(false)
  expect(second.blockedBy?.owner.id).toBe('sm')
})

test('creates claiming pheromone when claim is acquired', () => {
  const store = new InMemoryPheromoneStore()
  const manager = new ClaimManager(store)

  const claim = manager.acquire({
    scope,
    owner: sm,
    reason: 'SM is planning task',
    now: '2026-06-22T10:00:00.000Z',
  })

  expect(claim.acquired).toBe(true)
  expect(store.activeForScope(scope, '2026-06-22T10:01:00.000Z')).toEqual([
    expect.objectContaining({
      type: 'claiming',
      owner: sm,
      reason: 'SM is planning task',
    }),
  ])
})

test('releases an active lease and allows a new owner to acquire immediately', () => {
  const store = new InMemoryPheromoneStore()
  const manager = new ClaimManager(store)

  const first = manager.acquire({
    scope,
    owner: sm,
    reason: 'SM is planning task',
    now: '2026-06-22T10:00:00.000Z',
  })

  expect(first.acquired).toBe(true)
  expect(first.lease).toBeDefined()
  expect(manager.release(first.lease!.id, '2026-06-22T10:00:30.000Z')).toBe(true)

  const second = manager.acquire({
    scope,
    owner: qa,
    reason: 'QA wants same task',
    now: '2026-06-22T10:01:00.000Z',
  })

  expect(second.acquired).toBe(true)
  expect(second.lease?.owner.id).toBe('qa')
})

test('returns no active lease after the lease expires', () => {
  const store = new InMemoryPheromoneStore()
  const manager = new ClaimManager(store)

  const acquired = manager.acquire({
    scope,
    owner: sm,
    reason: 'SM is planning task',
    now: '2026-06-22T10:00:00.000Z',
  })

  expect(acquired.acquired).toBe(true)
  expect(manager.activeLeaseForScope(scope, '2026-06-22T10:59:00.000Z')?.id).toBe(
    acquired.lease?.id
  )
  expect(manager.activeLeaseForScope(scope, '2026-06-22T11:01:00.000Z')).toBeUndefined()
})

test('uses exact scope when looking up active leases', () => {
  const store = new InMemoryPheromoneStore()
  const manager = new ClaimManager(store)

  manager.acquire({
    scope,
    owner: sm,
    reason: 'SM is planning task',
    now: '2026-06-22T10:00:00.000Z',
  })

  expect(
    manager.activeLeaseForScope(
      { type: 'issue', wingId: 'loureng/gitorch', targetId: '43' },
      '2026-06-22T10:01:00.000Z'
    )
  ).toBeUndefined()
})

test('returns safe lease copies', () => {
  const store = new InMemoryPheromoneStore()
  const manager = new ClaimManager(store)

  const first = manager.acquire({
    scope,
    owner: sm,
    reason: 'SM is planning task',
    now: '2026-06-22T10:00:00.000Z',
  })

  first.lease!.owner.id = 'mutated-owner'
  first.lease!.scope.targetId = 'mutated-scope'

  const blocked = manager.acquire({
    scope,
    owner: qa,
    reason: 'QA wants same task',
    now: '2026-06-22T10:05:00.000Z',
  })

  blocked.blockedBy!.owner.id = 'mutated-blocked-owner'

  expect(manager.activeLeaseForScope(scope, '2026-06-22T10:06:00.000Z')).toMatchObject({
    owner: { id: 'sm' },
    scope: { targetId: '42' },
  })
})
