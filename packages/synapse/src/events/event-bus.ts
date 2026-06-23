import type { SynapseEvent, SynapseEventType, SynapseScope } from '../types'

export type SynapseEventHandler = (event: SynapseEvent) => void

export function sameScope(left: SynapseScope, right: SynapseScope): boolean {
  return (
    left.type === right.type && left.wingId === right.wingId && left.targetId === right.targetId
  )
}

export class SynapseEventBus {
  private readonly events: SynapseEvent[] = []
  private readonly subscribers = new Map<SynapseEventType, Set<SynapseEventHandler>>()

  publish(event: SynapseEvent): void {
    this.events.push(event)

    const handlers = this.subscribers.get(event.type)
    if (!handlers) {
      return
    }

    for (const handler of handlers) {
      handler(event)
    }
  }

  subscribe(type: SynapseEventType, handler: SynapseEventHandler): () => void {
    const handlers = this.subscribers.get(type) ?? new Set<SynapseEventHandler>()
    handlers.add(handler)
    this.subscribers.set(type, handlers)

    return () => {
      const currentHandlers = this.subscribers.get(type)
      if (!currentHandlers) {
        return
      }

      currentHandlers.delete(handler)
      if (currentHandlers.size === 0) {
        this.subscribers.delete(type)
      }
    }
  }

  allEvents(): SynapseEvent[] {
    return [...this.events]
  }

  eventsForScope(scope: SynapseScope): SynapseEvent[] {
    return this.events.filter((event) => sameScope(event.scope, scope))
  }
}
