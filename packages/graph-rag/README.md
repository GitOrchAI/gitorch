# @gitorch/graph-rag

Deterministic Graph RAG pipeline for GitOrch Phase F3.

The package turns a raw issue into a graph-aware retrieval payload using the Code Graph Model sequence:

```text
Issue → Rewriter → Cortex L0-L3 Context → Retriever → Reranker → Reader → ReaderPayload
```

## What it provides

- `QueryRewriter` — converts an issue into extractor entities, keywords, functional requirements, and behavioral expectations.
- `GraphRetriever` — resolves blue/red anchors and expands a connected rooted subgraph.
- `DynamicBudgetReranker` — ranks candidate files with file-name and skeleton scoring, thresholding, and a 70/30 context budget.
- `GraphReader` — builds deterministic node tokens and patch-ready reader payloads.
- `CortexGraphRAGAdapter` — supplies Cortex L0-L3 context for Graph RAG orchestration.
- `GraphRAGPipeline` — end-to-end orchestration from issue to `ReaderPayload`.

## Basic usage

```ts
import { GraphRAGPipeline, InMemoryGraphRepository } from '@gitorch/graph-rag'

const repository = new InMemoryGraphRepository({
  nodes: [
    { id: 'repo', label: 'REPO', type: 'repo', name: 'repo' },
    {
      id: 'file',
      label: 'FILE',
      type: 'file',
      filePath: 'src/modeling/separable.py',
      name: 'separable.py',
      signature: 'module separable.py',
    },
    {
      id: 'function',
      label: 'FUNC',
      type: 'function',
      filePath: 'src/modeling/separable.py',
      name: 'separability_matrix',
      signature: 'separability_matrix(model)',
    },
  ],
  edges: [
    { source: 'repo', target: 'file', type: 'CONTAINS' },
    { source: 'file', target: 'function', type: 'CONTAINS' },
  ],
})

const pipeline = new GraphRAGPipeline({ repository })

const result = await pipeline.run(
  'src/modeling/separable.py separability_matrix fails with nested models',
  { wingId: 'astropy-modeling' }
)

console.log(result.payload.rankedFiles)
console.log(result.payload.nodeTokens)
```

## Public contracts

```ts
export interface ExtractorOutput {
  entities: string[]
  keywords: string[]
}

export interface InfererOutput {
  functionalReq: string
  behavioralExpectation: string
}

export interface GraphRAGPlan {
  rawIssue: string
  extractor: ExtractorOutput
  inferer: InfererOutput
  wingId?: string
  roomId?: string
  hallId?: string
}

export interface GraphNode {
  id: string
  label: string
  type: string
  filePath?: string
  name?: string
  signature?: string
  docComment?: string
  properties?: Record<string, unknown>
}

export interface GraphEdge {
  source: string
  target: string
  type: string
  properties?: Record<string, unknown>
}

export interface Anchor {
  id: string
  kind: 'blue' | 'red'
  score: number
  reason: string
}

export interface ExpandedSubgraph {
  anchors: Anchor[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  isolatedNodes: GraphNode[]
}

export interface RankedFile {
  filePath: string
  score: number
  reasons: string[]
  tokenCount: number
  skeleton?: string
}

export interface ReaderPayload {
  wingId?: string
  graphSummary: string
  rankedFiles: RankedFile[]
  nodeTokens: string[]
  patchFormatInstructions: string
}

export interface GraphRAGPipelineResult {
  plan: GraphRAGPlan
  payload: ReaderPayload
}
```

## Design notes

F3 is deterministic and testable. It intentionally does **not** train CodeT5+, GNNs, or graph-attention models. The first release focuses on orchestration and context preparation for external LLMs/developers.

The reranker uses:

- file-name rank against extractor entities and keywords;
- skeleton rank against signatures, names, and doc comments;
- a relevance threshold of `> 0.75`;
- a default 70/30 split over a 128k-token context window.

The retriever validates connectivity by requiring rooted paths back to the `REPO` node and isolates nodes that cannot be reached through the graph hierarchy.

## Validation

```bash
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag lint
pnpm --filter @gitorch/graph-rag build
```
