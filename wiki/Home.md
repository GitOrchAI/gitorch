# GitOrch Wiki

GitOrch is a TypeScript monorepo for multi-agent engineering workflows on GitHub repositories.

Today the public surface is centered on two packages:

- `@gitorch/cgc` for structural code intelligence, graph indexing, impact analysis, and SCIP export
- `@gitorch/cortex` for layered memory retrieval backed by SQLite and ChromaDB

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

## Project Status

The current public status is:

- F0 complete
- F1 complete
- F2 complete
- F3 and beyond planned, not yet shipped

Use the [Roadmap](Roadmap.md) page for the current phase list.
