# Architecture Overview

GitOrch currently exposes five shipped subsystems: CodeSight, Cortex, Graph RAG, Synapse, and GitHub Sync.

## High-Level Layout

```text
GitOrch
|- CodeSight (@gitorch/cgc)
|  |- TreeSitterManager
|  |- CodeGraphIndexer
|  |- ImpactAnalyzer
|  `- ScipExporter
|- Cortex (@gitorch/cortex)
|  |- LayerSelector
|  |- CortexClient
|  |- SqliteStore
|  |- ChromaSemanticStore
|  `- AakCodec
|- Graph RAG (@gitorch/graph-rag)
|  |- QueryRewriter
|  |- Retriever
|  |- Reranker
|  `- Reader
|- Synapse (@gitorch/synapse)
|  |- ExecutionLedger
|  |- ClaimManager
|  |- PheromonePolicy
|  `- DecisionBriefService
`- GitHub Sync (@gitorch/github-sync)
   |- GitHubWebhookVerifier
   |- GitHubWebhookNormalizer
   |- GitHubWorkModel
   |- ProjectV2Client
   `- GitHubSynapseAdapter
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

## Graph RAG

Graph RAG is the deterministic retrieval pipeline delivered in F3.

Its main responsibilities are:

- rewrite user intent into retrieval plans
- retrieve code and memory context from graph-backed repositories
- rerank candidate context for relevance
- produce reader-ready answers from selected context

## Synapse

Synapse is the coordination memory subsystem delivered in F4.

Its main responsibilities are:

- record execution events in an append-only ledger
- manage claims so agents can coordinate work ownership
- evaluate pheromone signals for coordination and risk
- persist coordination memory through Cortex

## GitHub Sync

GitHub Sync is the GitHub-native synchronization substrate delivered in F5.

Its main responsibilities are:

- verify GitHub webhook deliveries
- normalize GitHub issues, pull requests, sub-issues, dependencies, and Projects V2 item events
- model Epic, Feature, Task, Bug, Security, and Improvement issue types
- derive ready or blocked work from issue dependencies
- publish GitHub work events into Synapse
- prepare Projects V2 GraphQL mutations for GitHub-native workflow state

## Current Scope

Shipped now:

- CodeSight indexing
- impact analysis
- SCIP export
- Cortex layered retrieval
- SQLite temporal store
- ChromaDB semantic store
- deterministic embedding fallback
- Graph RAG retrieval pipeline
- Synapse execution memory and coordination primitives
- GitHub Sync webhook, dependency, hierarchy, and Projects V2 sync substrate

Planned later:

- agent coordination runtime
- control plane API
- mission control frontend
