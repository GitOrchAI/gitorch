### Task 8: SynapseClient coordination facade

**Files:**
- Create/modify: `packages/synapse/src/synapse-client.ts`
- Test: `packages/synapse/src/synapse-client.test.ts`

**Interfaces:**
- Consumes: event bus, execution ledger, pheromone store, claim manager, and decision brief service.
- Produces: single public API for F4 consumers.

**Global requirements for this task:**
- Use TDD.
- Do not introduce autonomous agents or a dev/dev-agent role.
- The facade must expose the non-repetition execution primitive from Task 3.

**Required test behavior:**
```ts
import { SynapseClient } from './synapse-client'

test('observes issue, chooses next execution action, and acquires claim', () => {
  const synapse = new SynapseClient()
  const scope = { type: 'issue' as const, wingId: 'loureng/gitorch', targetId: '42' }

  synapse.observeIssue({
    scope,
    actor: { id: 'system', role: 'system' },
    title: 'Coordinate F4',
    now: '2026-06-22T10:00:00.000Z',
  })

  const run = synapse.startExecution({
    agent: { id: 'ra-main', role: 'ra' },
    scope,
    scheduledFor: '2026-06-22T10:00:00.000Z',
    actionKey: 'benchmark:critical-function',
    now: '2026-06-22T10:00:05.000Z',
  })

  synapse.completeExecution(run.id, {
    completedAt: '2026-06-22T10:10:00.000Z',
    summary: 'Benchmarked critical function.',
    evidenceRefs: ['cortex:drawer:benchmark'],
    nextCandidateActions: ['benchmark:second-critical-function'],
  })

  const decision = synapse.chooseNextAction({ id: 'ra-main', role: 'ra' }, scope, [
    'benchmark:critical-function',
    'benchmark:second-critical-function',
  ])

  const claim = synapse.acquireClaim({
    scope,
    owner: { id: 'sm', role: 'sm' },
    reason: 'SM is coordinating',
    now: '2026-06-22T10:11:00.000Z',
  })

  expect(decision.actionKey).toBe('benchmark:second-critical-function')
  expect(decision.repeated).toBe(false)
  expect(claim.acquired).toBe(true)
  expect(synapse.events().map((event) => event.type)).toContain('issue.observed')
  expect(synapse.activePheromones(scope, '2026-06-22T10:12:00.000Z')).toHaveLength(1)
})
```

**Required implementation shape:**
- `SynapseClientOptions`
- `ObserveIssueInput`
- `SynapseClient`
  - `observeIssue(input: ObserveIssueInput): SynapseEvent`
  - `startExecution(input: StartExecutionInput): ExecutionRecord`
  - `completeExecution(recordId: string, input: CompleteExecutionInput): ExecutionRecord`
  - `chooseNextAction(agent: SynapseActor, scope: SynapseScope, candidates: string[]): NextActionDecision`
  - `acquireClaim(input: AcquireClaimInput): AcquireClaimResult`
  - `markBlocked(scope: SynapseScope, owner: SynapseActor, reason: string, now: string): PheromoneMark`
  - `requestDecision(input: RequestDecisionBriefInput): DecisionBrief`
  - `activePheromones(scope: SynapseScope, now: string): PheromoneMark[]`
  - `events(): SynapseEvent[]`

**Validation commands:**
```bash
node_modules\.bin\vitest.cmd run --root packages\synapse src/synapse-client.test.ts
node_modules\.bin\vitest.cmd run --root packages\synapse
node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json
node_modules\.bin\eslint.cmd packages\synapse\src
```

**Commit:**
```bash
git add packages/synapse/src/synapse-client.ts packages/synapse/src/synapse-client.test.ts .superpowers/sdd/task-8-report.md
git commit -m "feat(synapse): add coordination client facade"
```
