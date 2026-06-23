# Task 3 Report

Implemented an in-memory execution ledger for Synapse that can start and complete runs, return agent-and-scope history, and choose the next unseen candidate action without repeating a previously completed one.

Validation:
- `node_modules\.bin\vitest.cmd run --root packages\synapse src/executions/execution-ledger.test.ts`
- `node_modules\.bin\vitest.cmd run --root packages\synapse`
- `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- `node_modules\.bin\eslint.cmd packages\synapse\src`

Concerns:
- The ledger is in-memory only, by design for this release.
- `historyForAgent()` currently returns records in insertion order, which is deterministic for this implementation.

## Review Fix 1

Reviewer findings:
- Returned records were shallow copies, so callers could mutate stored ledger state through nested `agent`, `scope`, and arrays.
- Tests only covered the happy-path next-action case.

Fixes:
- Added tests for start/complete record details, exact-scope filtering, repeated fallback behavior, and immutable returned records.
- Added `cloneRecord()`, `cloneActor()`, and `cloneScope()` so stored records and returned records do not share mutable nested references.

RED:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/executions/execution-ledger.test.ts`
- Result: failed with `expected [] to have a length of 1 but got +0`, proving mutation of input scope broke stored history.

GREEN:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/executions/execution-ledger.test.ts`
- Result: pass, 1 file, 3 tests.
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse`
- Result: pass, 3 files, 6 tests.
- Command: `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- Result: pass, exit 0.
- Command: `node_modules\.bin\eslint.cmd packages\synapse\src`
- Result: pass, exit 0.
