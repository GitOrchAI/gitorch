# Architecture Overview

GitOrch currently exposes two shipped subsystems: CodeSight and Cortex.

## High-Level Layout

```text
GitOrch
|- CodeSight (@gitorch/cgc)
|  |- TreeSitterManager
|  |- CodeGraphIndexer
|  |- ImpactAnalyzer
|  `- ScipExporter
`- Cortex (@gitorch/cortex)
   |- LayerSelector
   |- CortexClient
   |- SqliteStore
   |- ChromaSemanticStore
   `- AakCodec
```

## CodeSight

CodeSight is the structural code intelligence layer.

Its main responsibilities are:

- parse source text using Tree-sitter WASM
- normalize symbols and files into a KuzuDB graph
- create `CONTAINS`, `CALLS`, and `IMPORTS` relationships
- compute impact traversal from a changed symbol
- export indexed data as SCIP-like structures

### Data Model

CodeSight writes two node tables and several relationship tables:

- `File`
- `Symbol`
- `CONTAINS`
- `CALLS`
- `IMPORTS`

Symbol ids follow the `cgc://path#scope.name` pattern.

## Cortex

Cortex is the layered memory subsystem delivered in F2.

### Retrieval Layers

- `L0`: identity and invariant orchestration rules
- `L1`: wake-up based on top-priority drawers
- `L2`: scoped recall by `wingId`, `roomId`, and `hallId`
- `L3`: semantic retrieval through ChromaDB-compatible search

### Persistence

SQLite stores:

- identities
- drawers
- temporal triples

ChromaDB stores:

- drawer embeddings
- scoped semantic metadata for L3 search

### Compression

AAAK is a deterministic lossy codec used to compress drawer content into a compact transport format.

## Current Scope

Shipped now:

- CodeSight indexing
- impact analysis
- SCIP export
- Cortex layered retrieval
- SQLite temporal store
- ChromaDB semantic store
- deterministic embedding fallback

Planned later:

- Graph RAG orchestration pipeline
- agent coordination runtime
- control plane API
- mission control frontend
