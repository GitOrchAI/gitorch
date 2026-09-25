export interface CGCNode {
  id: string
  label: string
  type:
    | 'function'
    | 'class'
    | 'method'
    | 'interface'
    | 'type'
    | 'variable'
    | 'import'
    | 'export'
    | 'contract_endpoint'
    | 'schema_model'
    | 'event_topic'
  filePath: string
  startLine: number
  endLine: number
  startCol: number
  endCol: number
  properties?: Record<string, unknown>
}

export interface ContractEndpointNode extends CGCNode {
  type: 'contract_endpoint'
  properties?: {
    method: string
    path: string
  } & Record<string, unknown>
}

export interface SchemaModelNode extends CGCNode {
  type: 'schema_model'
  properties?: {
    modelName: string
  } & Record<string, unknown>
}

export interface EventTopicNode extends CGCNode {
  type: 'event_topic'
  properties?: {
    topicName: string
  } & Record<string, unknown>
}

export interface CGCEdge {
  id: string
  source: string
  target: string
  type:
    'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'CONTAINS' | 'REFERENCES' | 'CROSS_REPO_CALL'
  properties?: Record<string, unknown>
}

export interface CrossRepoCallEdge extends CGCEdge {
  type: 'CROSS_REPO_CALL'
  properties?: {
    callerRepo?: string
    calleeRepo?: string
  } & Record<string, unknown>
}

export interface CGCSymbol {
  name: string
  kind: CGCNode['type']
  signature?: string
  docComment?: string
  node: CGCNode
}

export interface ParseResult {
  filePath: string
  language: string
  nodes: CGCNode[]
  edges: CGCEdge[]
  symbols: CGCSymbol[]
}
