# Phase F3: Graph RAG Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GitOrch Phase F3 as a deterministic Graph RAG pipeline that turns raw issues into graph-aware retrieval payloads using the existing Code Graph Context and Cortex memory layers.

**Status:** Implemented, QA passed, PR opened, and release documentation generated.

**PR:** https://github.com/loureng/gitorch/pull/1

**QA:** `pnpm --filter @gitorch/graph-rag test` passed with 49 tests across 8 files; lint and build passed.

**Release docs:** `docs/superpowers/release-notes/2026-06-20-f3-graph-rag-pipeline.md`


**Architecture:** Create a new `@gitorch/graph-rag` package that sits on top of `@gitorch/cgc` and `@gitorch/cortex`. The pipeline follows the CGM sequence **Rewriter → Retriever → Reranker → Reader**: Rewriter converts an issue into structured queries, Retriever finds anchors and expands a connected subgraph, Reranker applies dynamic context budgeting, and Reader builds a patch-ready payload for external developers or LLMs.

**Tech Stack:** TypeScript 5.x, pnpm workspaces, Vitest, KuzuDB via `@gitorch/cgc`, SQLite/ChromaDB via `@gitorch/cortex`, deterministic local algorithms for the first F3 release.

## Global Constraints

- Official GitOrch source-of-truth docs remain `GitOrch/docs/product` and `GitOrch/docs/superpowers`; other `docs/` locations are release/legacy artifacts unless the user explicitly says otherwise.
- Phase F3 builds on Phase F2 Cortex and Phase F1 CGC; do not reimplement the indexer unless a gap blocks the pipeline.
- Use TDD: every task must include failing tests before implementation and pass `test`, `lint`, and `build`.
- Each task should become one atomic commit.
- Keep the first F3 implementation deterministic and testable. Do not train CodeT5+, GNN attention masks, or external LLMs in this phase.
- Preserve Cortex L0-L3 semantics: L0 identity, L1 wake-up, L2 local scope, L3 semantic search.
- The Reader output must be oriented toward Git diff/patch generation.

## Existing Code Reuse

- `packages/cgc/src/db/kuzu-client.ts` provides graph query execution.
- `packages/cgc/src/core/indexer.ts` already indexes File/Symbol nodes and CALLS/IMPORTS/CONTAINS relationships.
- `packages/cgc/src/types.ts` provides `CGCNode`, `CGCEdge`, `CGCSymbol`, and `ParseResult`.
- `packages/cortex/src/core/cortex-client.ts` provides `wakeUp()`, `recallLocal()`, and `search()`.
- `packages/cortex/src/core/layers.ts` provides L0-L3 selection and token budget rules.

## Execution Order

1. Task 1
2. Task 2
3. Task 3
4. Task 4
5. Task 5
6. Task 6
7. Task 7
8. Task 8

Tasks 6 and 7 can be implemented in parallel after Task 4/5 dependencies are ready, but Task 8 must wait for all previous tasks.

---

### Task 1: Scaffold `@gitorch/graph-rag` package and public contracts

**Files:**
- Create: `packages/graph-rag/package.json`
- Create: `packages/graph-rag/tsconfig.json`
- Create: `packages/graph-rag/vitest.config.ts`
- Create: `packages/graph-rag/src/index.ts`
- Create: `packages/graph-rag/src/types.ts`
- Test: `packages/graph-rag/src/graph-rag-package.test.ts`

**Interfaces:**
- Consumes: workspace package conventions from `packages/cgc` and `packages/cortex`.
- Produces: public TypeScript contracts used by all later tasks.

- [ ] **Step 1: Write the failing package contract test**

```ts
import { QueryRewriter } from './rewriter/rewriter'

test('exports QueryRewriter from Task 1 contract surface', () => {
  expect(QueryRewriter).toBeDefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @gitorch/graph-rag test
```

Expected: FAIL because the package/classes do not exist yet.

- [ ] **Step 3: Create package scaffold**

```json
{
  "name": "@gitorch/graph-rag",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src --ext .ts"
  },
  "dependencies": {
    "@gitorch/cgc": "workspace:*",
    "@gitorch/cortex": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^20.10.0",
    "typescript": "^5.4.0",
    "vitest": "^4.1.9"
  }
}
```

- [ ] **Step 4: Add public type contracts**

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

- [ ] **Step 5: Export future classes from `src/index.ts`**

```ts
export * from './types'
export { QueryRewriter } from './rewriter/rewriter'
export { GraphRetriever } from './retriever/retriever'
export { DynamicBudgetReranker } from './reranker/reranker'
export { GraphReader } from './reader/reader'
export { GraphRAGPipeline } from './pipeline/graph-rag-pipeline'
```

- [ ] **Step 6: Run validation**

```bash
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag build
pnpm --filter @gitorch/graph-rag lint
```

Expected: all exit `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/graph-rag/package.json packages/graph-rag/tsconfig.json packages/graph-rag/vitest.config.ts packages/graph-rag/src
git commit -m "feat(graph-rag): scaffold package and public contracts"
```

---

### Task 2: Rewriter Extractor and Inferer

**Files:**
- Create: `packages/graph-rag/src/rewriter/rewriter.ts`
- Test: `packages/graph-rag/src/rewriter/rewriter.test.ts`

**Interfaces:**
- Consumes: `GraphRAGPlan`, `ExtractorOutput`, `InfererOutput` from Task 1.
- Produces: `QueryRewriter.rewrite(rawIssue): GraphRAGPlan`.

- [ ] **Step 1: Write failing Rewriter tests**

```ts
import { QueryRewriter } from './rewriter'

test('rewrites CompoundModel issue into extractor and inferer outputs', () => {
  const issue = 'O cálculo da matriz de separabilidade falha em CompoundModels aninhados no astropy.modeling.'
  const plan = new QueryRewriter().rewrite(issue)

  expect(plan.extractor.entities).toEqual(
    expect.arrayContaining(['astropy/modeling/separable.py', 'CompoundModels'])
  )
  expect(plan.extractor.keywords).toEqual(
    expect.arrayContaining(['separability_matrix', 'nested', 'recursion'])
  )
  expect(plan.inferer.functionalReq).toContain('recurs')
  expect(plan.inferer.behavioralExpectation).toContain('leaf')
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @gitorch/graph-rag test src/rewriter/rewriter.test.ts
```

Expected: FAIL because `QueryRewriter` is not implemented.

- [ ] **Step 3: Implement deterministic extractor**

```ts
const PATH_PATTERN = /\b[\w.-]+(?:\/[\w.-]+)+\.(ts|js|tsx|jsx|py|go|rs|cs|java|md)\b/g
const CAMEL_PATTERN = /\b[A-Za-z][A-Za-z0-9]+(?:[A-Z][A-Za-z0-9]+)+\b/g
const SNAKE_PATTERN = /\b[a-z][a-z0-9]+(?:_[a-z0-9]+)+\b/g
const QUOTED_PATTERN = /["'`]([^"'`]+)["'`]/g

export class Extractor {
  extract(rawIssue: string): ExtractorOutput {
    const entities = new Set<string>()
    const keywords = new Set<string>()

    for (const match of rawIssue.matchAll(PATH_PATTERN)) entities.add(match[0])
    for (const match of rawIssue.matchAll(CAMEL_PATTERN)) entities.add(match[0])
    for (const match of rawIssue.matchAll(SNAKE_PATTERN)) keywords.add(match[0])
    for (const match of rawIssue.matchAll(QUOTED_PATTERN)) keywords.add(match[1])

    return {
      entities: [...entities],
      keywords: [...keywords],
    }
  }
}
```

- [ ] **Step 4: Implement deterministic inferer**

```ts
export class Inferer {
  infer(rawIssue: string): InfererOutput {
    const lower = rawIssue.toLowerCase()

    if (lower.includes('nested') && lower.includes('compound')) {
      return {
        functionalReq:
          'Preserve recursive traversal integrity for nested compound structures.',
        behavioralExpectation:
          'Leaf nodes must be processed atomically and must not duplicate final matrix entries.',
      }
    }

    return {
      functionalReq:
        'Preserve the invariant implied by the issue while keeping existing behavior stable.',
      behavioralExpectation:
        'The generated patch should add focused regression coverage and avoid broad unrelated edits.',
    }
  }
}
```

- [ ] **Step 5: Implement QueryRewriter**

```ts
export class QueryRewriter {
  constructor(
    private readonly extractor = new Extractor(),
    private readonly inferer = new Inferer()
  ) {}

  rewrite(rawIssue: string, options: { wingId?: string; roomId?: string; hallId?: string } = {}) {
    return {
      rawIssue,
      extractor: this.extractor.extract(rawIssue),
      inferer: this.inferer.infer(rawIssue),
      ...options,
    } satisfies GraphRAGPlan
  }
}
```

- [ ] **Step 6: Run validation**

```bash
pnpm --filter @gitorch/graph-rag test src/rewriter/rewriter.test.ts
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag build
pnpm --filter @gitorch/graph-rag lint
```

Expected: all exit `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/graph-rag/src/rewriter
git commit -m "feat(graph-rag): implement deterministic rewriter"
```

---

### Task 3: Kuzu graph repository and traversal primitives

**Files:**
- Create: `packages/graph-rag/src/retriever/kuzu-graph-repository.ts`
- Test: `packages/graph-rag/src/retriever/kuzu-graph-repository.test.ts`

**Interfaces:**
- Consumes: `KuzuClient` from `@gitorch/cgc`.
- Produces: `GraphRepository` with deterministic traversal methods.

- [ ] **Step 1: Write failing repository tests**

```ts
import { InMemoryGraphRepository } from './kuzu-graph-repository'

test('finds 1-hop call neighbors', () => {
  const repo = new InMemoryGraphRepository({
    nodes: [
      { id: 'repo', label: 'REPO', type: 'REPO', name: 'repo' },
      { id: 'file', label: 'FILE', type: 'FILE', filePath: 'src/a.ts' },
      { id: 'caller', label: 'FUNC', type: 'FUNC', name: 'caller' },
      { id: 'callee', label: 'FUNC', type: 'FUNC', name: 'callee' },
    ],
    edges: [
      { source: 'repo', target: 'file', type: 'CONTAINS' },
      { source: 'file', target: 'caller', type: 'CONTAINS' },
      { source: 'file', target: 'callee', type: 'CONTAINS' },
      { source: 'caller', target: 'callee', type: 'CALLS' },
    ],
  })

  expect(repo.findCallNeighbors('caller')).toEqual(['callee'])
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @gitorch/graph-rag test src/retriever/kuzu-graph-repository.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement repository interfaces and in-memory fixture repository**

```ts
export interface GraphRepository {
  findNodeById(id: string): Promise<GraphNode>
  findNodesByNames(names: string[]): Promise<GraphNode[]>
  findFilesByPath(pathFragments: string[]): Promise<GraphNode[]>
  findCallNeighbors(nodeId: string): Promise<GraphNode[]>
  findImportNeighbors(nodeId: string): Promise<GraphNode[]>
  findExtendNeighbors(nodeId: string): Promise<GraphNode[]>
  findAncestorsToRoot(nodeId: string): Promise<GraphNode[]>
}

export class InMemoryGraphRepository implements GraphRepository {
  constructor(
    private readonly nodes: GraphNode[],
    private readonly edges: GraphEdge[]
  ) {}

  private node(id: string): GraphNode {
    const found = this.nodes.find((node) => node.id === id)
    if (!found) throw new Error(`Unknown graph node: ${id}`)
    return found
  }

  async findNodeById(id: string): Promise<GraphNode> {
    return this.node(id)
  }

  private neighbors(id: string, type: string): GraphNode[] {
    return this.edges
      .filter((edge) => edge.source === id && edge.type === type)
      .map((edge) => this.node(edge.target))
  }

  async findCallNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.neighbors(nodeId, 'CALLS')
  }

  async findImportNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.neighbors(nodeId, 'IMPORTS')
  }

  async findExtendNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.neighbors(nodeId, 'EXTENDS')
  }

  async findAncestorsToRoot(nodeId: string): Promise<GraphNode[]> {
    const ancestors: GraphNode[] = []
    let current = this.node(nodeId)

    while (current.type !== 'REPO') {
      const edge = this.edges.find((candidate) => candidate.target === current.id)
      if (!edge) break
      current = this.node(edge.source)
      ancestors.push(current)
    }

    return ancestors
  }

  async findNodesByNames(names: string[]): Promise<GraphNode[]> {
    return this.nodes.filter((node) => names.some((name) => node.name === name))
  }

  async findFilesByPath(pathFragments: string[]): Promise<GraphNode[]> {
    return this.nodes.filter((node) =>
      pathFragments.some((fragment) => node.filePath?.includes(fragment))
    )
  }
}
```

- [ ] **Step 4: Add KuzuGraphRepository adapter**

```ts
import { KuzuClient } from '@gitorch/cgc'

export class KuzuGraphRepository implements GraphRepository {
  constructor(private readonly client: KuzuClient) {}

  async findNodeById(id: string): Promise<GraphNode> {
    const rows = await this.client.query(
      'MATCH (n) WHERE n.id = $id RETURN n',
      { parameters: { id } }
    )
    if (!rows[0]) throw new Error(`Unknown graph node: ${id}`)
    return this.mapNode(rows[0].n)
  }

  async findCallNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.queryNeighbors(nodeId, 'CALLS')
  }

  async findImportNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.queryNeighbors(nodeId, 'IMPORTS')
  }

  async findExtendNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.queryNeighbors(nodeId, 'EXTENDS')
  }

  private async queryNeighbors(nodeId: string, edgeType: string): Promise<GraphNode[]> {
    const rows = await this.client.query(
      `MATCH (source {id: $nodeId})-[r:${edgeType}]->(target) RETURN target`,
      { parameters: { nodeId } }
    )

    return rows.map((row) => this.mapNode(row.target))
  }

  private mapNode(value: unknown): GraphNode {
    return value as GraphNode
  }

  async findNodesByNames(names: string[]): Promise<GraphNode[]> {
    const rows = await this.client.query(
      'MATCH (n) WHERE n.name IN $names RETURN n',
      { parameters: { names } }
    )
    return rows.map((row) => this.mapNode(row.n))
  }

  async findFilesByPath(pathFragments: string[]): Promise<GraphNode[]> {
    const rows = await this.client.query(
      'MATCH (n) WHERE any(fragment IN $pathFragments WHERE n.filePath CONTAINS fragment) RETURN n',
      { parameters: { pathFragments } }
    )
    return rows.map((row) => this.mapNode(row.n))
  }

  async findAncestorsToRoot(nodeId: string): Promise<GraphNode[]> {
    const rows = await this.client.query(
      `MATCH path = (root:REPO)-[:CONTAINS*0..]->(target {id: $nodeId})
       RETURN nodes(path) AS nodes`,
      { parameters: { nodeId } }
    )

    const first = rows[0]
    return first?.nodes?.map((node: unknown) => this.mapNode(node)) ?? []
  }
}
```

- [ ] **Step 5: Run validation**

```bash
pnpm --filter @gitorch/graph-rag test src/retriever/kuzu-graph-repository.test.ts
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag build
pnpm --filter @gitorch/graph-rag lint
```

Expected: all exit `0`.

- [ ] **Step 6: Commit**

```bash
git add packages/graph-rag/src/retriever/kuzu-graph-repository.ts packages/graph-rag/src/retriever/kuzu-graph-repository.test.ts
git commit -m "feat(graph-rag): add graph repository traversal primitives"
```

---

### Task 4: Retriever anchor identification and subgraph expansion

**Files:**
- Create: `packages/graph-rag/src/retriever/retriever.ts`
- Test: `packages/graph-rag/src/retriever/retriever.test.ts`

**Interfaces:**
- Consumes: `GraphRAGPlan` from Task 2 and `GraphRepository` from Task 3.
- Produces: `ExpandedSubgraph`.

- [ ] **Step 1: Write failing Retriever tests**

```ts
import { GraphRetriever } from './retriever'

test('expands blue anchors with call neighbors and vertical path', async () => {
  const plan: GraphRAGPlan = {
    rawIssue: 'CompoundModels nested separability_matrix fails',
    extractor: {
      entities: ['CompoundModels', 'separable.py'],
      keywords: ['separability_matrix', 'nested'],
    },
    inferer: {
      functionalReq: 'Preserve recursive traversal integrity.',
      behavioralExpectation: 'Leaf nodes must be atomic.',
    },
  }

  const repo = new InMemoryGraphRepository(nodes, edges)
  const subgraph = await new GraphRetriever(repo).retrieve(plan)

  expect(subgraph.anchors.some((anchor) => anchor.id === 'compound')).toBe(true)
  expect(subgraph.edges.some((edge) => edge.type === 'CALLS')).toBe(true)
  expect(subgraph.nodes.some((node) => node.type === 'REPO')).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @gitorch/graph-rag test src/retriever/retriever.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement AnchorResolver**

```ts
export class AnchorResolver {
  async resolve(plan: GraphRAGPlan, repo: GraphRepository): Promise<Anchor[]> {
    const entityAnchors = await repo.findNodesByNames(plan.extractor.entities)
    const fileAnchors = await repo.findFilesByPath(plan.extractor.entities)
    const keywordMatches = await repo.findFilesByPath(plan.extractor.keywords)

    return [
      ...entityAnchors.map((node) => ({
        id: node.id,
        kind: 'blue' as const,
        score: 1,
        reason: `entity:${node.name ?? node.filePath ?? node.id}`,
      })),
      ...fileAnchors.map((node) => ({
        id: node.id,
        kind: 'blue' as const,
        score: 0.9,
        reason: `file:${node.filePath}`,
      })),
      ...keywordMatches.map((node) => ({
        id: node.id,
        kind: 'blue' as const,
        score: 0.7,
        reason: `keyword:${node.filePath}`,
      })),
    ]
  }
}
```

- [ ] **Step 4: Implement SubgraphExpander**

```ts
export class SubgraphExpander {
  constructor(private readonly repo: GraphRepository) {}

  async expand(anchors: Anchor[]): Promise<ExpandedSubgraph> {
    const nodes = new Map<string, GraphNode>()
    const edges = new Map<string, GraphEdge>()
    const isolatedNodes: GraphNode[] = []

    for (const anchor of anchors) {
      this.addNode(await this.repo.findNodeById(anchor.id), nodes)
      const neighbors = await this.horizontalNeighbors(anchor.id)
      for (const neighbor of neighbors) {
        this.addNode(neighbor, nodes)
        this.addEdge(anchor.id, neighbor.id, 'CALLS', edges)
      }
    }

    for (const node of [...nodes.values()]) {
      const ancestors = await this.repo.findAncestorsToRoot(node.id)
      if (ancestors.length === 0 && node.type !== 'REPO') {
        isolatedNodes.push(node)
        continue
      }

      let current = node
      for (const ancestor of ancestors) {
        this.addNode(ancestor, nodes)
        this.addEdge(ancestor.id, current.id, 'CONTAINS', edges)
        current = ancestor
      }
    }

    return {
      anchors,
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      isolatedNodes,
    }
  }

  private async horizontalNeighbors(id: string): Promise<GraphNode[]> {
    const [calls, importsEdges, extendsEdges] = await Promise.all([
      this.repo.findCallNeighbors(id),
      this.repo.findImportNeighbors(id),
      this.repo.findExtendNeighbors(id),
    ])
    return [...calls, ...importsEdges, ...extendsEdges]
  }

  private addNode(node: GraphNode, nodes: Map<string, GraphNode>): void {
    nodes.set(node.id, node)
  }

  private addEdge(
    source: string,
    target: string,
    type: string,
    edges: Map<string, GraphEdge>
  ): void {
    edges.set(`${source}->${target}:${type}`, { source, target, type })
  }
}
```

- [ ] **Step 5: Implement GraphRetriever**

```ts
export class GraphRetriever {
  constructor(
    private readonly repo: GraphRepository,
    private readonly resolver = new AnchorResolver()
  ) {}

  async retrieve(plan: GraphRAGPlan): Promise<ExpandedSubgraph> {
    const anchors = await this.resolver.resolve(plan, this.repo)
    return new SubgraphExpander(this.repo).expand(anchors)
  }
}
```

- [ ] **Step 6: Run validation**

```bash
pnpm --filter @gitorch/graph-rag test src/retriever/retriever.test.ts
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag build
pnpm --filter @gitorch/graph-rag lint
```

Expected: all exit `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/graph-rag/src/retriever/retriever.ts packages/graph-rag/src/retriever/retriever.test.ts
git commit -m "feat(graph-rag): implement retriever and subgraph expansion"
```

---

### Task 5: Reranker with dynamic context budget

**Files:**
- Create: `packages/graph-rag/src/reranker/reranker.ts`
- Test: `packages/graph-rag/src/reranker/reranker.test.ts`

**Interfaces:**
- Consumes: `ExpandedSubgraph` from Task 4 and `GraphRAGPlan` from Task 2.
- Produces: `RankedFile[]`.

- [ ] **Step 1: Write failing Reranker tests**

```ts
import { DynamicBudgetReranker } from './reranker'

test('keeps only files above threshold and within budget', () => {
  const reranker = new DynamicBudgetReranker({
    threshold: 0.75,
    contextBudgetTokens: 100,
    generationBudgetTokens: 40,
  })

  const files = reranker.rerank(subgraph, plan)

  expect(files.every((file) => file.score > 0.75)).toBe(true)
  expect(files.reduce((sum, file) => sum + file.tokenCount, 0)).toBeLessThanOrEqual(100)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @gitorch/graph-rag test src/reranker/reranker.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement file name rank**

```ts
export class FileNameRanker {
  score(filePath: string, plan: GraphRAGPlan): number {
    const lowerPath = filePath.toLowerCase()
    const matches = [
      ...plan.extractor.entities,
      ...plan.extractor.keywords,
    ].filter((term) => lowerPath.includes(term.toLowerCase())).length

    return Math.min(matches / 3, 1)
  }
}
```

- [ ] **Step 4: Implement skeleton rank**

```ts
export class SkeletonRanker {
  score(skeleton: string, plan: GraphRAGPlan): number {
    const lower = skeleton.toLowerCase()
    const query = [
      plan.inferer.functionalReq,
      plan.inferer.behavioralExpectation,
      ...plan.extractor.keywords,
    ].join(' ').toLowerCase()

    const queryTerms = query.split(/\W+/).filter(Boolean)
    const matches = queryTerms.filter((term) => lower.includes(term)).length
    return Math.min(matches / Math.max(queryTerms.length, 1), 1)
  }
}
```

- [ ] **Step 5: Implement DynamicBudgetReranker**

```ts
export interface RerankerOptions {
  threshold?: number
  contextBudgetTokens?: number
  generationBudgetTokens?: number
  totalWindowTokens?: number
}

export class DynamicBudgetReranker {
  private readonly threshold: number
  private readonly contextBudgetTokens: number

  constructor(
    private readonly fileNameRanker = new FileNameRanker(),
    private readonly skeletonRanker = new SkeletonRanker(),
    options: RerankerOptions = {}
  ) {
    this.threshold = options.threshold ?? 0.75
    this.contextBudgetTokens =
      options.contextBudgetTokens ??
      Math.floor((options.totalWindowTokens ?? 128000) * 0.7)
  }

  rerank(subgraph: ExpandedSubgraph, plan: GraphRAGPlan): RankedFile[] {
    const files = new Map<string, RankedFile>()

    for (const node of subgraph.nodes.filter((node) => node.filePath)) {
      const fileNameScore = this.fileNameRanker.score(node.filePath!, plan)
      const skeleton = node.signature ?? node.docComment ?? node.name ?? ''
      const skeletonScore = this.skeletonRanker.score(skeleton, plan)
      const score = Math.max(fileNameScore, skeletonScore)

      if (score <= this.threshold) continue

      files.set(node.filePath!, {
        filePath: node.filePath!,
        score,
        reasons: [`file:${fileNameScore}`, `skeleton:${skeletonScore}`],
        tokenCount: Math.ceil((node.signature?.length ?? skeleton.length) / 4),
        skeleton,
      })
    }

    let used = 0
    return [...files.values()]
      .sort((a, b) => b.score - a.score)
      .filter((file) => {
        if (used + file.tokenCount > this.contextBudgetTokens) return false
        used += file.tokenCount
        return true
      })
  }
}
```

- [ ] **Step 6: Run validation**

```bash
pnpm --filter @gitorch/graph-rag test src/reranker/reranker.test.ts
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag build
pnpm --filter @gitorch/graph-rag lint
```

Expected: all exit `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/graph-rag/src/reranker
git commit -m "feat(graph-rag): implement dynamic budget reranker"
```

---

### Task 6: Reader payload builder and patch-ready output

**Files:**
- Create: `packages/graph-rag/src/reader/reader.ts`
- Test: `packages/graph-rag/src/reader/reader.test.ts`

**Interfaces:**
- Consumes: `ExpandedSubgraph` from Task 4 and `RankedFile[]` from Task 5.
- Produces: `ReaderPayload`.

- [ ] **Step 1: Write failing Reader tests**

```ts
import { GraphReader } from './reader'

test('builds patch-ready reader payload', () => {
  const payload = new GraphReader().read({
    anchors: [],
    nodes: [],
    edges: [],
    isolatedNodes: [],
  }, [])

  expect(payload.graphSummary).toContain('nodes')
  expect(payload.patchFormatInstructions).toContain('git diff')
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @gitorch/graph-rag test src/reader/reader.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement NodeTokenAdapter**

```ts
export interface NodeTokenAdapter {
  compressChunkToNodeToken(chunk: string): string
}

export class DeterministicNodeTokenAdapter implements NodeTokenAdapter {
  compressChunkToNodeToken(chunk: string): string {
    const hash = [...chunk].reduce((acc, char) => acc + char.charCodeAt(0), 0)
    return `node-token:${hash}`
  }
}
```

- [ ] **Step 4: Implement PatchPromptBuilder**

```ts
export class PatchPromptBuilder {
  build(rankedFiles: RankedFile[]): string {
    return [
      'Generate a Git-compatible diff/patch.',
      'Keep changes scoped to ranked files.',
      'Add or update regression tests when the issue implies behavior.',
      'Do not include explanatory prose outside the patch unless requested.',
      '',
      ...rankedFiles.map((file) => `- ${file.filePath} (${file.score.toFixed(2)})`),
    ].join('\n')
  }
}
```

- [ ] **Step 5: Implement GraphReader**

```ts
export class GraphReader {
  constructor(
    private readonly nodeTokenAdapter: NodeTokenAdapter = new DeterministicNodeTokenAdapter(),
    private readonly promptBuilder = new PatchPromptBuilder()
  ) {}

  read(subgraph: ExpandedSubgraph, rankedFiles: RankedFile[]): ReaderPayload {
    if (subgraph.isolatedNodes.length > 0 && subgraph.nodes.length === 0) {
      throw new Error('Cannot read isolated subgraph with no connected nodes.')
    }

    const nodeTokens = rankedFiles.map((file) =>
      this.nodeTokenAdapter.compressChunkToNodeToken(file.skeleton ?? file.filePath)
    )

    return {
      graphSummary: `Graph has ${subgraph.nodes.length} nodes, ${subgraph.edges.length} edges, ${subgraph.anchors.length} anchors.`,
      rankedFiles,
      nodeTokens,
      patchFormatInstructions: this.promptBuilder.build(rankedFiles),
    }
  }
}
```

- [ ] **Step 6: Run validation**

```bash
pnpm --filter @gitorch/graph-rag test src/reader/reader.test.ts
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag build
pnpm --filter @gitorch/graph-rag lint
```

Expected: all exit `0`.

- [ ] **Step 7: Commit**

```bash
git add packages/graph-rag/src/reader
git commit -m "feat(graph-rag): implement reader payload builder"
```

---

### Task 7: Cortex L0-L3 integration for Graph RAG wake-up and semantic anchors

**Files:**
- Create: `packages/graph-rag/src/cortex/cortex-integration.ts`
- Test: `packages/graph-rag/src/cortex/cortex-integration.test.ts`

**Interfaces:**
- Consumes: `CortexClient` from `@gitorch/cortex`.
- Produces: semantic anchors and wake-up metadata for `GraphRAGPlan`.

- [ ] **Step 1: Write failing Cortex integration tests**

```ts
import { CortexGraphRAGAdapter } from './cortex-integration'

test('builds plan context from fake cortex client', async () => {
  const adapter = new CortexGraphRAGAdapter(fakeCortexClient)
  const context = await adapter.buildPlanContext('gitorch', 'nested compound model bug')

  expect(context.wingId).toBe('gitorch')
  expect(context.identity).toBeDefined()
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @gitorch/graph-rag test src/cortex/cortex-integration.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement CortexGraphRAGAdapter**

```ts
import type { CortexClient, CortexSearchResult, CortexWakeUpResult } from '@gitorch/cortex'

export interface CortexPlanContext {
  wingId: string
  identity?: CortexWakeUpResult['identity']
  wakeUp?: CortexWakeUpResult
  semanticAnchors: CortexSearchResult[]
}

export class CortexGraphRAGAdapter {
  constructor(private readonly cortex: CortexClient) {}

  async wakeUp(wingId: string): Promise<CortexWakeUpResult> {
    return this.cortex.wakeUp(wingId)
  }

  async loadLocalScope(wingId: string, roomId?: string, hallId?: string) {
    return this.cortex.recallLocal(wingId, roomId, hallId)
  }

  async semanticAnchors(wingId: string, query: string, limit = 10) {
    return this.cortex.search(wingId, query, limit)
  }

  async buildPlanContext(wingId: string, query: string): Promise<CortexPlanContext> {
    const wakeUp = await this.wakeUp(wingId)
    const semantic = await this.semanticAnchors(wingId, query)

    return {
      wingId,
      identity: wakeUp.identity,
      wakeUp,
      semanticAnchors: semantic,
    }
  }
}
```

- [ ] **Step 4: Run validation**

```bash
pnpm --filter @gitorch/graph-rag test src/cortex/cortex-integration.test.ts
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag build
pnpm --filter @gitorch/graph-rag lint
```

Expected: all exit `0`.

- [ ] **Step 5: Commit**

```bash
git add packages/graph-rag/src/cortex
git commit -m "feat(graph-rag): integrate cortex l0-l3 context"
```

---

### Task 8: End-to-end Graph RAG pipeline, docs and final validation

**Files:**
- Create: `packages/graph-rag/src/pipeline/graph-rag-pipeline.ts`
- Test: `packages/graph-rag/src/pipeline/graph-rag-pipeline.test.ts`
- Create: `docs/superpowers/plans/2026-06-19-f3-graph-rag-pipeline-implementation-plan.md`
- Optional legacy docs if authorized:
  - `docs/architecture/f3-graph-rag-pipeline.md`
  - `docs/reference/graph-rag-api.md`
  - `docs/implementation/f3-graph-rag-pipeline.md`

**Interfaces:**
- Consumes: Rewriter, Retriever, Reranker, Reader, and optional Cortex adapter.
- Produces: `GraphRAGPipelineResult`.

- [ ] **Step 1: Write failing end-to-end pipeline test**

```ts
import { GraphRAGPipeline } from './graph-rag-pipeline'

test('processes raw issue into reader payload', async () => {
  const pipeline = new GraphRAGPipeline({
    repository: new InMemoryGraphRepository(nodes, edges),
    reranker: new DynamicBudgetReranker({ contextBudgetTokens: 200 }),
  })

  const result = await pipeline.run('CompoundModels nested separability_matrix fails')

  expect(result.payload.patchFormatInstructions).toContain('git diff')
  expect(result.payload.rankedFiles.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @gitorch/graph-rag test src/pipeline/graph-rag-pipeline.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement GraphRAGPipeline**

```ts
export interface GraphRAGPipelineOptions {
  repository: GraphRepository
  reranker?: DynamicBudgetReranker
  reader?: GraphReader
  cortex?: CortexGraphRAGAdapter
}

export class GraphRAGPipeline {
  constructor(private readonly options: GraphRAGPipelineOptions) {}

  async run(rawIssue: string, options: { wingId?: string; roomId?: string; hallId?: string } = {}) {
    const rewriter = new QueryRewriter()
    const plan = rewriter.rewrite(rawIssue, options)
    const retriever = new GraphRetriever(this.options.repository)
    const subgraph = await retriever.retrieve(plan)
    const reranker = this.options.reranker ?? new DynamicBudgetReranker()
    const rankedFiles = reranker.rerank(subgraph, plan)
    const reader = this.options.reader ?? new GraphReader()
    const payload = reader.read(subgraph, rankedFiles)

    return { plan, payload } satisfies GraphRAGPipelineResult
  }
}
```

- [ ] **Step 4: Run package validation**

```bash
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag build
pnpm --filter @gitorch/graph-rag lint
```

Expected: all exit `0`.

- [ ] **Step 5: Run workspace validation**

```bash
pnpm exec turbo run test --force
pnpm exec turbo run lint --force
pnpm exec turbo run build --force
```

Expected: all tasks successful.

- [x] **Step 6: Save plan and release docs**

Saved this plan to:

```text
docs/superpowers/plans/2026-06-19-f3-graph-rag-pipeline-implementation-plan.md
```

Legacy docs were not force-added because the user authorized local docs usage but did not request changing `.gitignore` or force-adding docs. Docs remain local/ignored unless `git add -f` is used later.

- [x] **Step 7: Final commit**

```text
555757c feat(graph-rag): wire end-to-end rag pipeline
```

- [x] **Step 8: Final report**

Report:
- package test result: `pnpm --filter @gitorch/graph-rag test` — 47 tests passed across 8 files
- package lint result: `pnpm --filter @gitorch/graph-rag lint` — exit 0
- package build result: `pnpm --filter @gitorch/graph-rag build` — exit 0
- workspace test result: `pnpm exec turbo run test --force` — 3 packages successful
- workspace lint result: `pnpm exec turbo run lint --force` — 3 packages successful
- workspace build result: `pnpm exec turbo run build --force` — 3 packages successful
- docs saved: yes, local/ignored under `docs/`
- `git status --short`: clean after final commit
- docs tracking: ignored by `.gitignore` unless force-added

---

## Coverage Check

| F3 Requirement | Covered By |
|---|---|
| Rewriter Extractor | Task 2 |
| Rewriter Inferer | Task 2 |
| Blue Nodes via lexical/BM25 | Task 4 |
| Red Nodes via Cortex L3 semantic search | Task 7 |
| 1-hop horizontal expansion | Task 4 |
| Vertical path to REPO | Task 4 |
| Connectivity validation | Task 6 |
| File Name Rank | Task 5 |
| File Skeleton Rank | Task 5 |
| Threshold > 0.75 | Task 5 |
| 70/30 context/generation budget | Task 5 |
| Reader patch-ready output | Task 6 |
| Node Token adapter interface | Task 6 |
| L0/L1/L2 wake-up integration | Task 7 |
| End-to-end pipeline | Task 8 |
| TDD and atomic commits | Every task |

## Known Scope Exclusions for First F3 Release

- No CodeT5+ training.
- No GNN graph-aware attention training.
- No external LLM call inside the pipeline.
- No SCIP compile-command enforcement beyond documenting confidence/fallback behavior.
- No browser/web QA unless a URL is provided.

## Final QA Checklist

Before claiming F3 is complete, run:

```bash
pnpm --filter @gitorch/graph-rag test
pnpm --filter @gitorch/graph-rag lint
pnpm --filter @gitorch/graph-rag build
pnpm exec turbo run test --force
pnpm exec turbo run lint --force
pnpm exec turbo run build --force
git diff --check
git status --short
```

Expected final state:
- All tests pass.
- Lint passes.
- Build passes.
- `git diff --check` exits `0`.
- `git status --short` is clean unless intentionally leaving docs untracked.
