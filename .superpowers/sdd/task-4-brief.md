### Task 4: Pheromone policy, half-life, and conflict rules

**Files:**
- Create/modify: `packages/synapse/src/pheromones/pheromone-policy.ts`
- Test: `packages/synapse/src/pheromones/pheromone-policy.test.ts`

**Interfaces:**
- Consumes: `PheromoneMark`.
- Produces: deterministic expiry, decay, and conflict rules.

**Global requirements for this task:**
- Use TDD: write failing pheromone policy tests first and verify failure before implementation.
- Do not introduce autonomous agents or a dev/dev-agent role.
- Warning pheromones do not decay automatically.
- Claiming, modifying, and warning are blocking pheromone types for competing owners.

**Required half-life / TTL rules:**
- `exploring`: 2 minutes
- `claiming`: 60 minutes
- `modifying`: 10 minutes
- `completed`: 1440 minutes
- `blocked`: 5 minutes
- `warning`: no automatic expiry

**Required test behavior:**
```ts
import { PheromonePolicy } from './pheromone-policy'
import type { PheromoneMark } from '../types'

const mark: PheromoneMark = {
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

test('assigns default expiry for claiming pheromone', () => {
  const policy = new PheromonePolicy()

  expect(policy.withExpiry(mark).expiresAt).toBe('2026-06-22T11:00:00.000Z')
})

test('does not expire warning pheromones', () => {
  const policy = new PheromonePolicy()

  expect(policy.withExpiry({ ...mark, type: 'warning' }).expiresAt).toBeUndefined()
})
```

**Required implementation shape:**
- `PheromonePolicy.withExpiry(mark: PheromoneMark): PheromoneMark`
- `PheromonePolicy.decay(mark: PheromoneMark, now: string): PheromoneMark | null`
- `PheromonePolicy.conflicts(existing: PheromoneMark, incoming: PheromoneMark, now: string): boolean`
- Export helper `addMinutes(value: string, minutes: number): string`

**Validation commands:**
```bash
node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-policy.test.ts
node_modules\.bin\vitest.cmd run --root packages\synapse
node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json
node_modules\.bin\eslint.cmd packages\synapse\src
```

**Commit:**
```bash
git add packages/synapse/src/pheromones .superpowers/sdd/task-4-report.md
git commit -m "feat(synapse): add pheromone decay policy"
```
