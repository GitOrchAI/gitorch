### Task 9: Cortex persistence adapter, docs, and final validation

**Files:**
- Create: `packages/synapse/src/cortex/synapse-cortex-adapter.ts`
- Test: `packages/synapse/src/cortex/synapse-cortex-adapter.test.ts`
- Create: `packages/synapse/README.md`
- Create: `docs/superpowers/release-notes/2026-06-22-f4-synapse-pheromones.md`
- Modify: `packages/synapse/src/index.ts`

**Interfaces:**
- Consumes: `CortexClient`-compatible writer methods: `writeTriple()` and `writeDrawer()`.
- Produces: Cortex-compatible persistence for events, executions, and pheromones without making SuperMemory a product dependency.

**Global requirements for this task:**
- Use TDD for the adapter.
- No product dependency on SuperMemory.
- Do not introduce autonomous agents or a dev/dev-agent role.
- Async development via Jules label is out of scope.

**Required test behavior:**
```ts
import { SynapseCortexAdapter } from './synapse-cortex-adapter'
import type { PheromoneMark } from '../types'

test('persists pheromone as triple and drawer', async () => {
  const writes: unknown[] = []
  const adapter = new SynapseCortexAdapter({
    writeTriple: (triple) => writes.push(['triple', triple]),
    writeDrawer: async (drawer) => writes.push(['drawer', drawer]),
  })

  const mark: PheromoneMark = {
    id: 'ph-1',
    type: 'blocked',
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
    owner: { id: 'qa', role: 'qa' },
    strength: 1,
    createdAt: '2026-06-22T10:00:00.000Z',
    updatedAt: '2026-06-22T10:00:00.000Z',
    expiresAt: '2026-06-22T10:05:00.000Z',
    reason: 'Tests failed',
    metadata: {},
  }

  await adapter.persistPheromone(mark)

  expect(writes).toHaveLength(2)
  expect(writes[0]).toEqual([
    'triple',
    expect.objectContaining({
      wingId: 'loureng/gitorch',
      subject: 'synapse:issue:42',
      predicate: 'HAS_PHEROMONE',
      object: 'blocked',
    }),
  ])
})
```

**Required implementation shape:**
- `CortexWriter`
- `SynapseCortexAdapter`
  - `persistEvent(event: SynapseEvent): Promise<void>`
  - `persistExecution(record: ExecutionRecord): Promise<void>`
  - `persistPheromone(mark: PheromoneMark): Promise<void>`
- Export `SynapseCortexAdapter` from `packages/synapse/src/index.ts`.

**Docs:**
- `packages/synapse/README.md` must explain:
  - event bus
  - execution ledger/non-repetition
  - pheromones
  - claims
  - decision briefs
  - Cortex persistence
  - scope exclusions: no autonomous agents, no dev agent, no Jules label routing in F4
- Release note under `docs/superpowers/release-notes/2026-06-22-f4-synapse-pheromones.md`.

**Validation commands:**
```bash
node_modules\.bin\vitest.cmd run --root packages\synapse src/cortex/synapse-cortex-adapter.test.ts
node_modules\.bin\vitest.cmd run --root packages\synapse
node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json
node_modules\.bin\eslint.cmd packages\synapse\src
```

**Commit:**
```bash
git add packages/synapse docs/superpowers/release-notes/2026-06-22-f4-synapse-pheromones.md .superpowers/sdd/task-9-report.md
git commit -m "feat(synapse): persist coordination state to cortex"
```
