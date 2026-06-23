# Task 6 Report

Status: DONE

## What changed

- Replaced the claim manager stub with a lease-backed implementation.
- Added `AcquireClaimInput` and `AcquireClaimResult` exports.
- Implemented `acquire()`, `release()`, and `activeLeaseForScope()` with a 60-minute lease window.
- Covered competing-claim rejection, release, and expiry behavior with tests.

## TDD Evidence

RED:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/claims/claim-manager.test.ts`
- Result: failed because `ClaimManager.acquire()` returned the stubbed shape and `acquired` was undefined.

GREEN:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/claims/claim-manager.test.ts`
- Result: pass, 1 file, 3 tests.

## Validation

- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/claims/claim-manager.test.ts`
- Result: pass, 1 file, 3 tests.
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse`
- Result: pass, 6 files, 23 tests.
- Command: `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- Result: pass, exit 0.
- Command: `node_modules\.bin\eslint.cmd packages\synapse\src`
- Result: pass, exit 0.

## Files changed

- `packages/synapse/src/claims/claim-manager.ts`
- `packages/synapse/src/claims/claim-manager.test.ts`

## Concerns

- The claim manager keeps its own in-memory lease ledger and does not persist releases into the pheromone store. That matches the current task scope, but any cross-process locking would need a different backing store.

## Review Fix 1

Reviewer findings:
- `InMemoryPheromoneStore` constructor dependency was unused.
- Tests did not cover safe lease copies or exact-scope lookup.

Fixes:
- `ClaimManager.acquire()` now creates a `claiming` pheromone with `leaseId` metadata.
- `ClaimManager.release()` now expires the associated claiming pheromone by `leaseId`, preserving history but preventing stale marks from blocking a new owner.
- Added tests for claiming pheromone creation, exact-scope lookup, and safe lease copies.
- Added `InMemoryPheromoneStore.expireByMetadata()` to expire stored marks by metadata key/value.

RED:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/claims/claim-manager.test.ts`
- Result: first failed with `expected [] to deeply equal [ ObjectContaining... ]`, proving no claiming pheromone was created.

GREEN:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/claims/claim-manager.test.ts`
- Result: pass, 1 file, 6 tests.
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse`
- Result: pass, 6 files, 26 tests.
- Command: `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- Result: pass, exit 0.
- Command: `node_modules\.bin\eslint.cmd packages\synapse\src`
- Result: pass, exit 0.
