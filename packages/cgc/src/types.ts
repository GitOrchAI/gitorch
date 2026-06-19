export interface CGCNode {
  id: string
  label: string
  type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'variable' | 'import' | 'export'
  filePath: string
  startLine: number
  endLine: number
  startCol: number
  endCol: number
  properties?: Record<string, unknown>
}

export interface CGCEdge {
  id: string
  source: string
  target: string
  type: 'CALLS' | 'IMPORTS' | 'EXTENDS' | 'IMPLEMENTS' | 'CONTAINS' | 'REFERENCES'
  properties?: Record<string, unknown>
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
