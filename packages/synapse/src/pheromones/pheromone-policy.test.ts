import { describe, expect, test } from 'vitest'
import { addMinutes, PheromonePolicy } from './pheromone-policy'
import type { PheromoneMark } from '../types'

const baseMark: PheromoneMark = {
  id: 'ph-1',
  type: 'claiming',
  scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
  owner: { id: 'sm', role: 'sm' },
  strength: 1,
  createdAt: '2026-06-22T10:00:00.000Z',
  updatedAt: '2026-06-22T10:00:00.000Z',
  reason: 'SM is assigning work',
  metadata: {},
}

describe('addMinutes', () => {
  test('adds minutes in UTC', () => {
    expect(addMinutes('2026-06-22T10:00:00.000Z', 60)).toBe('2026-06-22T11:00:00.000Z')
  })
})

describe('PheromonePolicy', () => {
  test('assigns default expiry for claiming pheromone', () => {
    const policy = new PheromonePolicy()

    expect(policy.withExpiry(baseMark).expiresAt).toBe('2026-06-22T11:00:00.000Z')
  })

  test('assigns the expected half-life for all expiring pheromone types', () => {
    const policy = new PheromonePolicy()

    expect(policy.withExpiry({ ...baseMark, type: 'exploring' }).expiresAt).toBe(
      '2026-06-22T10:02:00.000Z'
    )
    expect(policy.withExpiry({ ...baseMark, type: 'claiming' }).expiresAt).toBe(
      '2026-06-22T11:00:00.000Z'
    )
    expect(policy.withExpiry({ ...baseMark, type: 'modifying' }).expiresAt).toBe(
      '2026-06-22T10:10:00.000Z'
    )
    expect(policy.withExpiry({ ...baseMark, type: 'completed' }).expiresAt).toBe(
      '2026-06-23T10:00:00.000Z'
    )
    expect(policy.withExpiry({ ...baseMark, type: 'blocked' }).expiresAt).toBe(
      '2026-06-22T10:05:00.000Z'
    )
  })

  test('does not expire warning pheromones', () => {
    const policy = new PheromonePolicy()

    expect(policy.withExpiry({ ...baseMark, type: 'warning' }).expiresAt).toBeUndefined()
  })

  test('decays expired pheromones and preserves active warning pheromones', () => {
    const policy = new PheromonePolicy()

    expect(policy.decay(baseMark, '2026-06-22T11:01:00.000Z')).toBeNull()
    expect(policy.decay({ ...baseMark, type: 'warning' }, '2026-06-22T11:01:00.000Z')).toEqual({
      ...baseMark,
      type: 'warning',
      expiresAt: undefined,
    })
  })

  test('detects conflicts for active blocking marks from competing owners', () => {
    const policy = new PheromonePolicy()
    const existing = { ...baseMark, type: 'claiming' as const }
    const incoming = { ...baseMark, id: 'ph-2', owner: { id: 'qa', role: 'qa' } }

    expect(policy.conflicts(existing, incoming, '2026-06-22T10:01:00.000Z')).toBe(true)
  })

  test('does not conflict for the same owner or expired marks', () => {
    const policy = new PheromonePolicy()
    const incoming = { ...baseMark, id: 'ph-2', owner: { id: 'sm', role: 'sm' } }

    expect(policy.conflicts(baseMark, incoming, '2026-06-22T10:01:00.000Z')).toBe(false)
    expect(
      policy.conflicts(
        baseMark,
        { ...incoming, owner: { id: 'qa', role: 'qa' } },
        '2026-06-22T12:01:00.000Z'
      )
    ).toBe(false)
  })

  test('does not conflict when incoming mark is non-blocking', () => {
    const policy = new PheromonePolicy()
    const existing = { ...baseMark, type: 'claiming' as const }
    const incoming = {
      ...baseMark,
      id: 'ph-2',
      type: 'completed' as const,
      owner: { id: 'qa', role: 'qa' as const },
    }

    expect(policy.conflicts(existing, incoming, '2026-06-22T10:01:00.000Z')).toBe(false)
  })
})
