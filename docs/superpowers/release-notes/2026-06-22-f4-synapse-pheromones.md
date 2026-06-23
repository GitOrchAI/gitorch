# Document Release - GitOrch F4 Synapse Pheromones

## Release status

| Item | Status |
|---|---|
| Phase | F4 - Synapse + pheromones |
| Package | `@gitorch/synapse` |
| Date | 2026-06-22 |
| Scope | Coordination substrate |

## What shipped

F4 adds the Synapse coordination substrate for GitOrch:

- append-only coordination events;
- execution history with non-repetition for the same agent and scope;
- pheromone marks with deterministic decay and conflict checks;
- scoped claim leases;
- decision briefs for human intervention;
- Cortex-compatible persistence for events, executions, and pheromones.

The Cortex adapter writes triples and drawers through a Cortex-compatible writer surface. That keeps persistence inside GitOrch's own Cortex layer and avoids any product dependency on SuperMemory.

## Scope exclusions

F4 does not ship:

- autonomous agents or autonomous orchestration loops;
- a `dev` or `dev-agent` role;
- Jules label routing;
- a SuperMemory product dependency.

## Validation snapshot

Task 9 package validation was run locally with:

- `node_modules\.bin\vitest.cmd run --root packages\synapse src/cortex/synapse-cortex-adapter.test.ts`
- `node_modules\.bin\vitest.cmd run --root packages\synapse`
- `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- `node_modules\.bin\eslint.cmd packages\synapse\src`
