# GitOrch Wiki

GitOrch is a TypeScript monorepo for multi-agent engineering workflows on GitHub repositories.

Today the public surface is centered on five packages:

- `@gitorch/cgc` for structural code intelligence, graph indexing, impact analysis, and SCIP export
- `@gitorch/cortex` for layered memory retrieval backed by SQLite and ChromaDB
- `@gitorch/graph-rag` for deterministic retrieval and ranking over code and memory
- `@gitorch/synapse` for execution memory, pheromones, claims, decision briefs, and Cortex persistence
- `@gitorch/github-sync` for GitHub-native issue types, sub-issues, dependencies, Projects V2 operations, webhook normalization, and Synapse event publishing
- `@gitorch/agents` for multi-agent role assignment, task definition, and runtime configuration
- `@gitorch/workspace-engine` for KVM/Firecracker sandbox management, chroot bootstrap, and AuthProxy streams

## Start Here

- [Getting Started](Getting-Started.md)
- [Architecture Overview](Architecture-Overview.md)
- [CodeSight API](CodeSight-API.md)
- [Cortex API](Cortex-API.md)
- [Roadmap](Roadmap.md)

## What Is Available Today

### CodeSight

CodeSight is the F1 core. It can:

- parse source files with Tree-sitter WASM
- persist code structure in KuzuDB
- compute upstream and downstream impact through `CALLS` and `IMPORTS`
- export the indexed graph as SCIP-like data for downstream tooling

### Cortex

Cortex is the F2 core. It can:

- store identity and retrieval state across L0-L3 layers
- persist temporal facts in SQLite
- persist semantic drawers in ChromaDB
- run L1 wake-up, L2 scoped recall, and L3 semantic search
- compress drawer content with deterministic AAAK encoding

### Graph RAG

Graph RAG is the F3 retrieval pipeline. It can:

- rewrite incoming queries into deterministic retrieval plans
- retrieve graph-backed code and memory context
- rerank results before producing reader-ready answers

### Synapse

Synapse is the F4 coordination layer. It can:

- record execution events and decisions
- manage claims for agent-safe work ownership
- store pheromones for coordination signals
- persist coordination memory into Cortex

### GitHub Sync

GitHub Sync is the F5 GitHub-native work substrate. It can:

- verify GitHub webhook signatures
- normalize issue, pull request, sub-issue, dependency, and Projects V2 item events
- model blocked and ready work from issue dependencies
- publish GitHub work events into Synapse
- prepare Projects V2 GraphQL operations

## Project Status

The current public status is:

- F0 complete
- F1 complete
- F2 complete
- F3 complete
- F4 complete
- F5 complete
- F6 complete
- F7 complete
- F8 and beyond planned, not yet shipped

Use the [Roadmap](Roadmap.md) page for the current phase list.
