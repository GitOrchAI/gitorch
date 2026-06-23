# Task 7 Report: Decision briefs for human intervention

Implemented `packages/synapse/src/decision-briefs/decision-brief.ts` as an in-memory `DecisionBriefService` with:
- `request(input)` to create open decision briefs
- `answer(briefId, answerId, now)` to resolve a brief
- `open()` to list unanswered briefs

Validation performed:
- `node_modules\.bin\vitest.cmd run --root packages\synapse src/decision-briefs/decision-brief.test.ts`
- `node_modules\.bin\vitest.cmd run --root packages\synapse`
- `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- `node_modules\.bin\eslint.cmd packages\synapse\src`

Notes:
- Request rejects briefs with fewer than two options.
- Answer rejects unknown brief IDs and unknown option IDs.
- No unrelated files were modified.

## Review Fix 1

Reviewer finding:
- Tests did not assert open status, `open()` filtering, or defensive-copy behavior.

Fixes:
- Added assertion that `request()` returns an open brief.
- Added test that `open()` returns only unanswered briefs.
- Added defensive-copy test covering `request()`, `answer()`, and `open()` returned objects.

Validation after fix:
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse src/decision-briefs/decision-brief.test.ts`
- Result: pass, 1 file, 5 tests.
- Command: `node_modules\.bin\vitest.cmd run --root packages\synapse`
- Result: pass, 7 files, 31 tests.
- Command: `node_modules\.bin\tsc.cmd -p packages\synapse\tsconfig.json`
- Result: pass, exit 0.
- Command: `node_modules\.bin\eslint.cmd packages\synapse\src`
- Result: pass, exit 0.
