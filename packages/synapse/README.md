# @gitorch/synapse

Synapse is the F4 coordination package for GitOrch. It keeps coordination state explicit and deterministic without turning the package into an autonomous worker runtime.

## What it provides

### Event bus

`SynapseEventBus` records append-only coordination events and lets callers subscribe to specific event types.

### Execution ledger and non-repetition

`ExecutionLedger` records execution attempts per agent and scope, then chooses the next candidate action while skipping work that was already completed for the same agent and scope.

### Pheromones

`InMemoryPheromoneStore` and `PheromonePolicy` manage coordination marks such as `claiming`, `blocked`, and `warning`, including deterministic decay and conflict checks.

### Claims

`ClaimManager` issues scoped leases so one actor can hold an issue, file, or graph node while other actors get a deterministic rejection signal instead of racing.

### Decision briefs

`DecisionBriefService` creates bounded human-decision requests with explicit options and tradeoffs.

### Cortex persistence

`SynapseCortexAdapter` persists events, execution records, and pheromones through Cortex-compatible `writeTriple()` and `writeDrawer()` methods. This keeps Synapse integrated with Cortex storage without making SuperMemory part of the Synapse product contract.

## Public surface

- `SynapseEventBus`
- `ExecutionLedger`
- `PheromonePolicy`
- `InMemoryPheromoneStore`
- `ClaimManager`
- `DecisionBriefService`
- `SynapseClient`
- `SynapseCortexAdapter`

## Scope exclusions for F4

- No autonomous agents or autonomous coordination loops.
- No `dev` or `dev-agent` role.
- No Jules label routing.
- No product dependency on SuperMemory.
