# Roadmap

GitOrch follows a risk-first roadmap.

## Delivered

- **F0: Foundation** - monorepo, TypeScript, Vitest, lint, and build
- **F1: CodeSight Core** - Tree-sitter WASM, graph indexing, impact analysis, and SCIP export
- **F2: Cortex 4-Layer** - layered memory retrieval with SQLite and ChromaDB

## Planned

- **F3: Graph RAG Pipeline** - retrieval and ranking pipeline over code and memory
- **F4: Synapse + Pheromones** - coordination mechanisms for multi-agent workflows
- **F5: GitHub Sync & Projects V2** - backlog and workflow integration
- **F6: Agents** - runtime integration for orchestration roles
- **F7: Workspace Engine** - isolated execution for tests and builds
- **F8: Control Plane API** - service layer for orchestration operations
- **F9: Mission Control Frontend** - operator-facing UI
- **F10: Secrets Vault & Auth** - secret storage and access control
- **F11: Observability & Hardening** - telemetry, audit, and operational resilience

## Current Public Focus

If you are evaluating GitOrch today, focus on:

- `@gitorch/cgc` for code graph indexing and analysis
- `@gitorch/cortex` for layered retrieval and memory storage

The later phases describe direction, not shipped behavior.
