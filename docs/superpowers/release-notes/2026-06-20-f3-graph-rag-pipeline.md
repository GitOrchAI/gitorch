# Document Release — GitOrch F3 Graph RAG Pipeline

## Release status

| Item | Status |
|---|---|
| Phase | F3 — Graph RAG Pipeline |
| Package | `@gitorch/graph-rag` |
| Branch | `feature/f3-graph-rag-pipeline` |
| PR | https://github.com/loureng/gitorch/pull/1 |
| QA | Passed |
| Documentation type | Superpowers release note + package reference |
| Date | 2026-06-20 |

## What shipped

F3 introduces the deterministic Graph RAG pipeline for GitOrch. The new package converts raw issues into graph-aware retrieval payloads through the CGM sequence:

```text
Issue → Rewriter → Cortex L0-L3 Context → Retriever → Reranker → Reader → ReaderPayload
```

Implemented modules:

- `QueryRewriter` — deterministic extractor/inferer for entities, keywords, functional requirements, and behavioral expectations.
- `GraphRetriever` — blue/red anchor identification, 1-hop horizontal expansion, and vertical path expansion to `REPO`.
- `KuzuGraphRepository` + `InMemoryGraphRepository` — repository abstraction for graph traversal.
- `DynamicBudgetReranker` — file-name rank, skeleton rank, threshold `> 0.75`, and 70/30 context budget.
- `GraphReader` — deterministic node-token projection and patch-ready payload construction.
- `CortexGraphRAGAdapter` — integration with Cortex L0-L3 memory context.
- `GraphRAGPipeline` — end-to-end orchestration.

## QA evidence

```text
pnpm --filter @gitorch/graph-rag test
# Test Files  8 passed (8)
# Tests       49 passed (49)

pnpm --filter @gitorch/graph-rag lint
# exit 0

pnpm --filter @gitorch/graph-rag build
# exit 0

node --input-type=module -e "..."
# runtime smoke passed via built dist
```

## Coverage map

| Public surface | Reference | How-to | Tutorial | Explanation |
|---|---|---|---|---|
| `QueryRewriter` | `packages/graph-rag/README.md` | `packages/graph-rag/README.md` | ❌ | `docs/superpowers/release-notes/2026-06-20-f3-graph-rag-pipeline.md` |
| `GraphRetriever` | `packages/graph-rag/README.md` | ❌ | ❌ | `docs/superpowers/release-notes/2026-06-20-f3-graph-rag-pipeline.md` |
| `DynamicBudgetReranker` | `packages/graph-rag/README.md` | ❌ | ❌ | `docs/superpowers/release-notes/2026-06-20-f3-graph-rag-pipeline.md` |
| `GraphReader` | `packages/graph-rag/README.md` | ❌ | ❌ | `docs/superpowers/release-notes/2026-06-20-f3-graph-rag-pipeline.md` |
| `CortexGraphRAGAdapter` | `packages/graph-rag/README.md` | ❌ | ❌ | `docs/superpowers/release-notes/2026-06-20-f3-graph-rag-pipeline.md` |
| `GraphRAGPipeline` | `packages/graph-rag/README.md` | `packages/graph-rag/README.md` | ❌ | `docs/superpowers/release-notes/2026-06-20-f3-graph-rag-pipeline.md` |

## Documentation debt

- Add a tutorial showing an end-to-end GitOrch issue-to-patch Graph RAG run once the external developer adapter is wired.
- Add architecture diagrams once the code graph index and Cortex integration are documented in `docs/product`.
- Add package-level how-to docs for Kuzu-backed retrieval after KuzuClient tests and repository integration are stable.

## SuperMemory persistence

Saved to SuperMemory MCP in three containers:

| Container | Purpose | Memory ID |
|---|---|---|
| `GitOrch` | Implementation summary and PR/QA status | `jwNUoKSMwiri1gSuyQWpH1` |
| `gitorch` | Technical decision: no CodeT5+/GNN training in F3 | `5swR9PKWAFU7usJKgXE5Qa` |
| `gitorch-mvp` | Progress update and next step | `YHQEZiF7A6EpJxV9SGXkCp` |

## Release note

The F3 Graph RAG Pipeline is documented as a deterministic first release: it does **not** train CodeT5+, GNNs, or graph-attention models. The phase keeps GitOrch focused on orchestration and context preparation for external LLMs/developers while using deterministic graph traversal, ranking, and compression to build high-signal payloads.
