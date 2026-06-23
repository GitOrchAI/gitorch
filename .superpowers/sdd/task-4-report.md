# Task 4 Report

Status: DONE_WITH_CONCERNS

## What changed

- Implemented `PheromonePolicy.withExpiry()`.
- Implemented `PheromonePolicy.decay()`.
- Implemented `PheromonePolicy.conflicts()`.
- Added `addMinutes()` helper.
- Added tests for TTL rules, warning behavior, expiry, and conflicts.

## TDD Evidence

RED:
- The worker did not write a report before being stopped, so exact RED output is unavailable.
- The placeholder before this task only returned marks unchanged and did not expose `withExpiry()`, `decay()`, or `conflicts()`, so the required tests would fail before implementation.

GREEN:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-policy.test.ts`
- Result: pass, 1 file, 7 tests.

## Validation

- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-policy.test.ts`
- Result: pass, 1 file, 7 tests.
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse`
- Result: pass, 4 files, 13 tests.
- Command: `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- Result: pass, exit 0.
- Command: `node_modules\.bin\eslint.cmd packages\synapse\src`
- Result: pass, exit 0.

## Files changed

- `packages/synapse/src/pheromones/pheromone-policy.ts`
- `packages/synapse/src/pheromones/pheromone-policy.test.ts`

## Self-review

- Warning pheromones remain non-expiring.
- Blocking conflicts are scoped by `type`, `wingId`, and `targetId`.
- Same-owner marks do not conflict.

## Concerns

- Exact RED output is unavailable because the worker was stopped before writing its report. Controller verified GREEN locally.

## Review Fix 1

Reviewer finding:
- `conflicts()` ignored `incoming.type`, so a non-blocking incoming mark could conflict with an existing blocking mark.

Fix:
- Added a negative test for non-blocking incoming pheromones.
- Updated `conflicts()` to require both the existing active mark and incoming mark to be blocking types.

RED:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-policy.test.ts`
- Result: failed with `expected true to be false`, reproducing the reviewer finding.

GREEN:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-policy.test.ts`
- Result: pass, 1 file, 8 tests.
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse`
- Result: pass, 4 files, 14 tests.
- Command: `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- Result: pass, exit 0.
- Command: `node_modules\.bin\eslint.cmd packages\synapse\src`
- Result: pass, exit 0.
