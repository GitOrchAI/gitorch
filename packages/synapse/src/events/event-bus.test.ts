import { describe, expect, it } from 'vitest'
import { SynapseEventBus } from './event-bus'
import type { SynapseEvent } from '../types'

describe('SynapseEventBus', () => {
  it('publishes events to subscribers and stores audit history', () => {
    const event: SynapseEvent = {
      id: 'evt-1',
      type: 'issue.observed',
      scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
      actor: { id: 'system', role: 'system' },
      payload: { title: 'Add event coordination' },
      createdAt: '2026-06-22T10:00:00.000Z',
    }

    const bus = new SynapseEventBus()
    const received: SynapseEvent[] = []

    bus.subscribe('issue.observed', (published) => received.push(published))
    bus.publish(event)

    expect(received).toEqual([event])
    expect(bus.allEvents()).toEqual([event])
    expect(bus.eventsForScope(event.scope)).toEqual([event])
  })
})
