### Task 3: Execution memory ledger and next-action selection

**Files:**
- Create/modify: `packages/synapse/src/executions/execution-ledger.ts`
- Test: `packages/synapse/src/executions/execution-ledger.test.ts`

**Interfaces:**
- Consumes: `ExecutionRecord`, `NextActionDecision`, `SynapseActor`, and `SynapseScope`.
- Produces: `ExecutionLedger.start()`, `complete()`, `historyForAgent()`, and `chooseNextAction()`.

**Global requirements for this task:**
- Use TDD: write the failing execution ledger test first and verify it fails before implementation.
- This task is the core of the user's non-repetition requirement.
- Scheduled agents must be able to inspect prior execution records and pick the next unseen action.
- Do not introduce a `dev` or `dev-agent` role.
- Keep behavior deterministic and in-memory for this first F4 package release.

**Required test behavior:**
```ts
import { ExecutionLedger } from './execution-ledger'

test('chooses a new action when prior scheduled run already completed the top candidate', () => {
  const ledger = new ExecutionLedger()
  const agent = { id: 'ra-main', role: 'ra' as const }
  const scope = { type: 'wing' as const, wingId: 'loureng/gitorch', targetId: 'loureng/gitorch' }

  const first = ledger.start({
    agent,
    scope,
    scheduledFor: '2026-06-21T00:00:00.000Z',
    actionKey: 'benchmark:critical-function',
    now: '2026-06-21T00:00:05.000Z',
  })

  ledger.complete(first.id, {
    completedAt: '2026-06-21T00:10:00.000Z',
    summary: 'Benchmarked the most critical function and stored findings.',
    evidenceRefs: ['cortex:drawer:ra-benchmark-critical-function'],
    nextCandidateActions: ['benchmark:second-critical-function', 'audit:critical-callers'],
  })

  const decision = ledger.chooseNextAction(agent, scope, [
    'benchmark:critical-function',
    'benchmark:second-critical-function',
    'audit:critical-callers',
  ])

  expect(decision).toEqual({
    actionKey: 'benchmark:second-critical-function',
    reason: 'Skipped 1 previously completed action for this agent and scope.',
    repeated: false,
  })
})
```

**Required implementation shape:**
- `StartExecutionInput`
- `CompleteExecutionInput`
- `ExecutionLedger`
  - `start(input: StartExecutionInput): ExecutionRecord`
  - `complete(recordId: string, input: CompleteExecutionInput): ExecutionRecord`
  - `historyForAgent(agent: SynapseActor, scope: SynapseScope): ExecutionRecord[]`
  - `chooseNextAction(agent: SynapseActor, scope: SynapseScope, candidateActions: string[]): NextActionDecision`
- If no unseen candidates remain, return the first candidate or `no-action` with `repeated: true`.

**Validation commands:**
```bash
node_modules\.bin\vitest.cmd run --root packages\synapse src/executions/execution-ledger.test.ts
node_modules\.bin\vitest.cmd run --root packages\synapse
node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json
node_modules\.bin\eslint.cmd packages\synapse\src
```

**Commit:**
```bash
git add packages/synapse/src/executions .superpowers/sdd/task-3-report.md
git commit -m "feat(synapse): add execution memory ledger"
```
