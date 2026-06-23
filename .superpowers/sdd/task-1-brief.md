### Task 1: Scaffold `@gitorch/synapse` package and public contracts

**Files:**
- Create: `packages/synapse/package.json`
- Create: `packages/synapse/tsconfig.json`
- Create: `packages/synapse/vitest.config.ts`
- Create: `packages/synapse/src/index.ts`
- Create: `packages/synapse/src/types.ts`
- Test: `packages/synapse/src/synapse-package.test.ts`

**Interfaces:**
- Consumes: existing pnpm workspace conventions from `packages/cortex` and `packages/graph-rag`.
- Produces: public F4 TypeScript contracts used by all later tasks.

**Global requirements for this task:**
- Use TDD: write the failing package export test first and verify it fails before production code.
- Do not introduce a `dev` or `dev-agent` role. Async development through Jules label routing is out of scope for F4.
- Include execution memory contracts so future scheduled agents can avoid repeating completed work.
- Keep public APIs typed and exported from `packages/synapse/src/index.ts`.

**Required public contracts in `src/types.ts`:**
- `AgentRole = 'owner' | 'ra' | 'po' | 'sm' | 'qa' | 'system'`
- `PheromoneType = 'exploring' | 'claiming' | 'modifying' | 'completed' | 'warning' | 'blocked'`
- `SynapseScopeType = 'wing' | 'issue' | 'pull-request' | 'file' | 'graph-node'`
- `SynapseEventType` must include:
  - `issue.observed`
  - `graph-rag.ready`
  - `execution.started`
  - `execution.completed`
  - `execution.skipped`
  - `pheromone.created`
  - `pheromone.decayed`
  - `claim.acquired`
  - `claim.rejected`
  - `claim.released`
  - `decision.requested`
  - `decision.answered`
- Interfaces:
  - `SynapseScope`
  - `SynapseActor`
  - `SynapseEvent<TPayload extends Record<string, unknown> = Record<string, unknown>>`
  - `PheromoneMark`
  - `ClaimLease`
  - `DecisionBrief`
  - `DecisionOption`
  - `ExecutionRecord`
  - `NextActionDecision`

**Required scaffold files:**

`packages/synapse/package.json`
```json
{
  "name": "@gitorch/synapse",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src"
  },
  "dependencies": {
    "@gitorch/cortex": "workspace:*",
    "@gitorch/graph-rag": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "typescript": "^5.4.0",
    "vitest": "^4.1.9"
  }
}
```

`packages/synapse/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

`packages/synapse/vitest.config.ts`
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    testTimeout: 10000,
  },
})
```

**Required `src/index.ts` exports:**
```ts
export * from './types'
export { SynapseEventBus } from './events/event-bus'
export { ExecutionLedger } from './executions/execution-ledger'
export { PheromonePolicy } from './pheromones/pheromone-policy'
export { InMemoryPheromoneStore } from './pheromones/pheromone-store'
export { ClaimManager } from './claims/claim-manager'
export { DecisionBriefService } from './decision-briefs/decision-brief'
export { SynapseClient } from './synapse-client'
```

**Important:** Task 1 may create minimal placeholder exported classes so package exports compile, but behavioral implementation belongs to later tasks. Placeholders must be small and not overbuilt.

**Validation commands:**
```bash
pnpm --filter @gitorch/synapse test
pnpm --filter @gitorch/synapse build
pnpm --filter @gitorch/synapse lint
```

**Commit:**
```bash
git add packages/synapse
git commit -m "feat(synapse): scaffold coordination package"
```
