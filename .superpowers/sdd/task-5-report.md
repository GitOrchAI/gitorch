# Task 5 Report

Status: DONE

## What changed

- Added `CreatePheromoneInput` and `InMemoryPheromoneStore`.
- Implemented `create()`, `activeForScope()`, `decayAll()`, and `history()`.
- Wired the store to `PheromonePolicy` for expiry and conflict checks.
- Added tests for scope filtering, competing-owner conflict rejection, and decay/history behavior.

## TDD Evidence

RED:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-store.test.ts`
- Result: failed with `TypeError: store.create is not a function`.

GREEN:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-store.test.ts`
- Result: pass, 1 file, 3 tests.

## Validation

- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-store.test.ts`
- Result: pass, 1 file, 3 tests.
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse`
- Result: pass, 5 files, 17 tests.
- Command: `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- Result: pass, exit 0.
- Command: `node_modules\.bin\eslint.cmd packages\synapse\src`
- Result: pass, exit 0.

## Files changed

- `packages/synapse/src/pheromones/pheromone-store.ts`
- `packages/synapse/src/pheromones/pheromone-store.test.ts`

## Concerns

- `decayAll()` currently returns the active marks after decay checks; it does not mutate the backing history, which keeps `history()` intact and matches the current tests.

## Review Fix 1

Reviewer findings:
- Tests did not cover exact-scope negative filtering, safe-copy behavior, same-owner writes, or expired competing blockers.
- Metadata copies were shallow, so nested metadata could mutate stored audit history.

Fixes:
- Added tests for same-owner writes, expired competing blockers, exact-scope filtering, and nested metadata immutability through `create()` and `history()`.
- Added `cloneMetadata()` using JSON serialization for JSON-like metadata records.

RED:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-store.test.ts`
- Result: failed with `expected { Object (nested) } to deeply equal { nested: { source: 'initial' } }`, proving nested metadata leaked.

GREEN:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/pheromones/pheromone-store.test.ts`
- Result: pass, 1 file, 6 tests.
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse`
- Result: pass, 5 files, 20 tests.
- Command: `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- Result: pass, exit 0.
- Command: `node_modules\.bin\eslint.cmd packages\synapse\src`
- Result: pass, exit 0.
