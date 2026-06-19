import { expect, test } from 'vitest'
import {
  type Anchor,
  type ExpandedSubgraph,
  type ExtractorOutput,
  type GraphEdge,
  type GraphNode,
  type GraphRAGPipelineResult,
  type GraphRAGPlan,
  type InfererOutput,
  type RankedFile,
  type ReaderPayload,
} from './index'

const extractorOutput: ExtractorOutput = {
  entities: ['GraphRAGPipelineResult'],
  keywords: ['graph', 'rag'],
}

const infererOutput: InfererOutput = {
  functionalReq: 'derive a graph-backed retrieval plan',
  behavioralExpectation: 'preserve traceability to source files',
}

const graphRagPlan: GraphRAGPlan = {
  rawIssue: 'Implement graph RAG pipeline',
  extractor: extractorOutput,
  inferer: infererOutput,
  wingId: 'wing-1',
  roomId: 'room-1',
  hallId: 'hall-1',
}

const graphNode: GraphNode = {
  id: 'node-1',
  label: 'Function',
  type: 'symbol',
  filePath: 'src/index.ts',
  name: 'main',
  signature: 'main(): void',
  docComment: 'Entry point',
  properties: {
    public: true,
  },
}

const graphEdge: GraphEdge = {
  source: 'node-1',
  target: 'node-2',
  type: 'depends_on',
  properties: {
    weight: 1,
  },
}

const anchor: Anchor = {
  id: 'node-1',
  kind: 'blue',
  score: 0.9,
  reason: 'directly matches the issue keywords',
}

const expandedSubgraph: ExpandedSubgraph = {
  anchors: [anchor],
  nodes: [graphNode],
  edges: [graphEdge],
  isolatedNodes: [],
}

const rankedFile: RankedFile = {
  filePath: 'src/index.ts',
  score: 0.8,
  reasons: ['contains public exports'],
  tokenCount: 42,
  skeleton: 'export type {...} from "./types"',
}

const readerPayload: ReaderPayload = {
  graphSummary: 'Graph RAG public contract scaffold',
  rankedFiles: [rankedFile],
  nodeTokens: ['export', 'type', 'GraphRAGPlan'],
  patchFormatInstructions: 'Return a unified diff.',
}

const pipelineResult: GraphRAGPipelineResult = {
  plan: graphRagPlan,
  payload: readerPayload,
}

test('exports Graph RAG public type contracts', () => {
  expect(pipelineResult.plan.extractor.keywords).toEqual(['graph', 'rag'])
  expect(pipelineResult.payload.rankedFiles[0]?.filePath).toBe('src/index.ts')
  expect(expandedSubgraph.edges[0]?.type).toBe('depends_on')
})
