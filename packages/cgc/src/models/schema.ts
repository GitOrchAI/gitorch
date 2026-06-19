export interface KuzuFileNode {
  id: string
  filePath: string
}

export interface KuzuSymbolNode {
  id: string
  name: string
  type: string
  filePath: string
  startLine: number
  endLine: number
  startCol: number
  endCol: number
}
