import { KuzuClient } from '../db/kuzu-client'

export interface ImpactResult {
  symbolId: string
  name: string
  filePath: string
  type: string
  depth: number
}

export class ImpactAnalyzer {
  constructor(private client: KuzuClient) {}

  async analyzeImpact(symbolId: string, maxDepth: number = 5): Promise<ImpactResult[]> {
    if (!symbolId || typeof symbolId !== 'string') {
      return []
    }
    if (typeof maxDepth !== 'number' || isNaN(maxDepth) || maxDepth < 1) {
      return []
    }
    const safeDepth = Math.min(Math.floor(maxDepth), 20)

    const query = `
      MATCH (target:Symbol {id: $symbolId})<-[r:CALLS|IMPORTS*1..${safeDepth}]-(affected:Symbol)
      RETURN 
        affected.id as id, 
        affected.name as name, 
        affected.filePath as filePath, 
        affected.type as type, 
        min(length(r)) as depth
    `

    const rows = await this.client.query(query, {
      parameters: { symbolId },
    })

    const results: ImpactResult[] = []
    for (const row of rows) {
      const id = row['id'] ? String(row['id']) : ''
      if (!id) continue

      const name = row['name'] ? String(row['name']) : ''
      const filePath = row['filePath'] ? String(row['filePath']) : ''
      const type = row['type'] ? String(row['type']) : ''
      const depth = row['depth'] !== undefined ? Number(row['depth']) : 0

      results.push({
        symbolId: id,
        name,
        filePath,
        type,
        depth,
      })
    }

    return results
  }
}
