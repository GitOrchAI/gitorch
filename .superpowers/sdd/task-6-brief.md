### Task 6: Claim manager with lease-based locks

**Files:**
- Create/modify: `packages/synapse/src/claims/claim-manager.ts`
- Test: `packages/synapse/src/claims/claim-manager.test.ts`

**Interfaces:**
- Consumes: `InMemoryPheromoneStore`, `SynapseActor`, `SynapseScope`.
- Produces: claim acquisition, rejection, release, and active lease lookup.

**Global requirements for this task:**
- Use TDD.
- Depends on Task 5 `InMemoryPheromoneStore`.
- Do not introduce autonomous agents or a dev/dev-agent role.
- Competing claims must be rejected while the active lease is valid.

**Required test behavior:**
```ts
import { ClaimManager } from './claim-manager'
import { InMemoryPheromoneStore } from '../pheromones/pheromone-store'

test('rejects competing claims until lease expires', () => {
  const store = new InMemoryPheromoneStore()
  const manager = new ClaimManager(store)
  const scope = { type: 'issue' as const, wingId: 'loureng/gitorch', targetId: '42' }

  const first = manager.acquire({
    scope,
    owner: { id: 'sm', role: 'sm' },
    reason: 'SM is planning task',
    now: '2026-06-22T10:00:00.000Z',
  })

  expect(first.acquired).toBe(true)

  const second = manager.acquire({
    scope,
    owner: { id: 'qa', role: 'qa' },
    reason: 'QA wants same task',
    now: '2026-06-22T10:05:00.000Z',
  })

  expect(second.acquired).toBe(false)
  expect(second.blockedBy?.owner.id).toBe('sm')
})
```

**Required implementation shape:**
- `AcquireClaimInput`
- `AcquireClaimResult`
- `ClaimManager`
  - `acquire(input: AcquireClaimInput): AcquireClaimResult`
  - `release(leaseId: string): boolean`
  - `activeLeaseForScope(scope: SynapseScope, now: string): ClaimLease | undefined`

**Validation commands:**
```bash
node_modules\.bin\vitest.cmd run --root packages\synapse src/claims/claim-manager.test.ts
node_modules\.bin\vitest.cmd run --root packages\synapse
node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json
node_modules\.bin\eslint.cmd packages\synapse\src
```

**Commit:**
```bash
git add packages/synapse/src/claims .superpowers/sdd/task-6-report.md
git commit -m "feat(synapse): add lease claim manager"
```
