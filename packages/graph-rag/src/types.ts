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
  graphSummary: string
  rankedFiles: RankedFile[]
  nodeTokens: string[]
  patchFormatInstructions: string
}

export interface GraphRAGPipelineResult {
  plan: GraphRAGPlan
  payload: ReaderPayload
}
