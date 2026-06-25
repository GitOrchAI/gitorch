# Document Release - GitOrch F6 Agents Runtime Orchestration

## Release status

| Item | Status |
|---|---|
| Phase | F6 - Agents |
| Package | `@gitorch/agents` |
| Date | 2026-06-24 |
| Scope | Backend agent runtime orchestration |

## What shipped

F6 adds the first backend package for GitOrch internal agents:

- runtime-independent roles for PO, RA, SM, and QA;
- MVP runtime defaults for Codex CLI, Claude Code CLI, and Antigravity CLI;
- credential-reference provisioning contracts for isolated environments;
- project onboarding recognition planning before task creation;
- Jules PR and QA merge gate decisions;
- Synapse-backed mission execution records.

## Boundaries

- No frontend runtime configuration.
- No F7 interactive login flow.
- No raw runtime secret persistence.
- No internal dev agent.
- Jules remains the external async development executor.

## Validation

The release is valid only after these commands pass in Task 8:

- `pnpm --filter @gitorch/agents test`
- `pnpm --filter @gitorch/agents build`
- `pnpm --filter @gitorch/agents lint`
- `pnpm test`
- `pnpm build`
- `pnpm lint`
- `pnpm lint:ci`
- `pnpm typecheck:strict`
- `pnpm audit:secrets`
- `git diff --check`
