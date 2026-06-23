### Task 5: Pheromone store and active mark queries

**Files:**
- Create/modify: `packages/synapse/src/pheromones/pheromone-store.ts`
- Test: `packages/synapse/src/pheromones/pheromone-store.test.ts`

**Interfaces:**
- Consumes: `PheromoneMark`, `PheromonePolicy`, `SynapseScope`.
- Produces: `InMemoryPheromoneStore.create()`, `activeForScope()`, `decayAll()`, and `history()`.

**Global requirements for this task:**
- Use TDD.
- Depends on Task 4 `PheromonePolicy`.
- Do not introduce autonomous agents or a dev/dev-agent role.
- Conflict checks must reject active blocking marks from competing owners.

**Required test behavior:**
```ts
import { InMemoryPheromoneStore } from './pheromone-store'

test('creates pheromone mark and filters active marks by scope', () => {
  const store = new InMemoryPheromoneStore()
  const mark = store.create({
    type: 'exploring',
    scope: { type: 'file', wingId: 'loureng/gitorch', targetId: 'packages/cgc/src/index.ts' },
    owner: { id: 'ra', role: 'ra' },
    reason: 'RA is inspecting file',
    metadata: {},
    now: '2026-06-22T10:00:00.000Z',
  })

  expect(mark.expiresAt).toBe('2026-06-22T10:02:00.000Z')
  expect(store.activeForScope(mark.scope, '2026-06-22T10:01:00.000Z')).toEqual([mark])
  expect(store.activeForScope(mark.scope, '2026-06-22T10:03:00.000Z')).toEqual([])
})
```

**Required implementation shape:**
- `CreatePheromoneInput`
- `InMemoryPheromoneStore`
  - `create(input: CreatePheromoneInput): PheromoneMark`
  - `activeForScope(scope: SynapseScope, now: string): PheromoneMark[]`
  - `decayAll(now: string): PheromoneMark[]`
  - `history(): PheromoneMark[]`

**Validation commands:**
```bash
node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-store.test.ts
node_modules\.bin\vitest.cmd run --root packages\synapse
node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json
node_modules\.bin\eslint.cmd packages\synapse\src
```

**Commit:**
```bash
git add packages/synapse/src/pheromones .superpowers/sdd/task-5-report.md
git commit -m "feat(synapse): add pheromone store"
```
