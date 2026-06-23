### Task 7: Decision briefs for human intervention

**Files:**
- Create/modify: `packages/synapse/src/decision-briefs/decision-brief.ts`
- Test: `packages/synapse/src/decision-briefs/decision-brief.test.ts`

**Interfaces:**
- Consumes: `DecisionBrief`, `DecisionOption`, `SynapseActor`, `SynapseScope`.
- Produces: open decision brief creation and answer handling.

**Global requirements for this task:**
- Use TDD.
- Do not introduce autonomous agents or a dev/dev-agent role.
- Decision briefs are the human stop point for high-impact or ambiguous choices.

**Required test behavior:**
```ts
import { DecisionBriefService } from './decision-brief'

test('creates and answers a decision brief', () => {
  const service = new DecisionBriefService()
  const brief = service.request({
    scope: { type: 'issue', wingId: 'loureng/gitorch', targetId: '42' },
    requestedBy: { id: 'po', role: 'po' },
    question: 'Should this high-impact change be delegated now?',
    options: [
      { id: 'approve', label: 'Delegate now', tradeoff: 'Faster delivery with higher risk.', recommended: false },
      { id: 'hold', label: 'Hold for review', tradeoff: 'Slower delivery with lower risk.', recommended: true },
    ],
    now: '2026-06-22T10:00:00.000Z',
  })

  const answered = service.answer(brief.id, 'hold', '2026-06-22T10:10:00.000Z')

  expect(answered.status).toBe('answered')
  expect(answered.answerId).toBe('hold')
})
```

**Required implementation shape:**
- `RequestDecisionBriefInput`
- `DecisionBriefService`
  - `request(input: RequestDecisionBriefInput): DecisionBrief`
  - `answer(briefId: string, answerId: string, now: string): DecisionBrief`
  - `open(): DecisionBrief[]`
- Request must require at least two options.
- Answer must reject invalid brief IDs and invalid answer IDs.

**Validation commands:**
```bash
node_modules\.bin\vitest.cmd run --root packages\synapse src/decision-briefs/decision-brief.test.ts
node_modules\.bin\vitest.cmd run --root packages\synapse
node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json
node_modules\.bin\eslint.cmd packages\synapse\src
```

**Commit:**
```bash
git add packages/synapse/src/decision-briefs .superpowers/sdd/task-7-report.md
git commit -m "feat(synapse): add decision brief service"
```
