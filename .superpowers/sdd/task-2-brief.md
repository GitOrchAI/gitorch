### Task 2: Synapse event bus and append-only audit log

**Files:**
- Create: `packages/synapse/src/events/event-bus.ts`
- Test: `packages/synapse/src/events/event-bus.test.ts`

**Interfaces:**
- Consumes: `SynapseEvent`, `SynapseEventType`, and `SynapseScope`.
- Produces: `SynapseEventBus.publish()`, `subscribe()`, `eventsForScope()`, and `allEvents()`.

**Global requirements for this task:**
- Use TDD: write the failing event bus test first and verify it fails before implementation.
- Do not introduce autonomous agents or a dev/dev-agent role.
- Keep the event log append-only and deterministic.
- Do not modify files outside `packages/synapse/src/events` unless an export in `packages/synapse/src/index.ts` is missing from Task 1.

**Required test behavior:**
```ts
import { SynapseEventBus } from './event-bus'
import type { SynapseEvent } from '../types'

const event: SynapseEvent = {
  id: 'evt-1',
  type: 'issue.observed',
  scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
  actor: { id: 'system', role: 'system' },
  payload: { title: 'Add event coordination' },
  createdAt: '2026-06-22T10:00:00.000Z',
}

test('publishes events to subscribers and stores audit history', () => {
  const bus = new SynapseEventBus()
  const received: SynapseEvent[] = []

  bus.subscribe('issue.observed', (published) => received.push(published))
  bus.publish(event)

  expect(received).toEqual([event])
  expect(bus.allEvents()).toEqual([event])
  expect(bus.eventsForScope(event.scope)).toEqual([event])
})
```

**Required implementation shape:**
- `SynapseEventHandler = (event: SynapseEvent) => void`
- `SynapseEventBus`
  - `publish(event: SynapseEvent): void`
  - `subscribe(type: SynapseEventType, handler: SynapseEventHandler): () => void`
  - `allEvents(): SynapseEvent[]`
  - `eventsForScope(scope: SynapseScope): SynapseEvent[]`
- Export helper:
  - `sameScope(left: SynapseScope, right: SynapseScope): boolean`

**Validation commands:**
```bash
pnpm --filter @gitorch/synapse test src/events/event-bus.test.ts
pnpm --filter @gitorch/synapse test
pnpm --filter @gitorch/synapse build
pnpm --filter @gitorch/synapse lint
```

**Commit:**
```bash
git add packages/synapse/src/events
git commit -m "feat(synapse): add event bus audit log"
```
