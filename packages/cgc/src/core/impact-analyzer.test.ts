import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { KuzuClient } from '../db/kuzu-client'
import { CodeGraphIndexer } from './indexer'
import { TreeSitterManager } from '../parser/tree-sitter-manager'
import { ImpactAnalyzer } from './impact-analyzer'

describe('ImpactAnalyzer', () => {
  let client: KuzuClient
  let indexer: CodeGraphIndexer
  let analyzer: ImpactAnalyzer

  beforeAll(async () => {
    client = new KuzuClient(':memory:')
    await client.init()
    const manager = new TreeSitterManager()
    indexer = new CodeGraphIndexer(client, manager)
    await indexer.initializeSchema()
    analyzer = new ImpactAnalyzer(client)
  })

  afterAll(async () => {
    await client.close()
  })

  beforeEach(async () => {
    try {
      await client.execute('MATCH (n) DETACH DELETE n')
    } catch (e) {
      // Ignorar
    }
  })

  it('deve rastrear dependencias diretas e indiretas (blast radius) de um simbolo alterado', async () => {
    // 1. Criar simbolos (soma, calcula, main, outro)
    await client.execute(`
      CREATE (s1:Symbol {id: 'soma-id', name: 'soma', filePath: 'src/math.ts', type: 'function', startLine: 1, endLine: 3, startCol: 1, endCol: 1})
    `)
    await client.execute(`
      CREATE (s2:Symbol {id: 'calcula-id', name: 'calcula', filePath: 'src/calc.ts', type: 'function', startLine: 1, endLine: 3, startCol: 1, endCol: 1})
    `)
    await client.execute(`
      CREATE (s3:Symbol {id: 'main-id', name: 'main', filePath: 'src/main.ts', type: 'function', startLine: 1, endLine: 3, startCol: 1, endCol: 1})
    `)
    await client.execute(`
      CREATE (s4:Symbol {id: 'outro-id', name: 'outro', filePath: 'src/outro.ts', type: 'function', startLine: 1, endLine: 3, startCol: 1, endCol: 1})
    `)

    // 2. Criar relacionamentos (outro -IMPORTS-> main -CALLS-> calcula -CALLS-> soma)
    await client.execute(`
      MATCH (caller:Symbol {id: 'calcula-id'}), (callee:Symbol {id: 'soma-id'})
      CREATE (caller)-[:CALLS]->(callee)
    `)
    await client.execute(`
      MATCH (caller:Symbol {id: 'main-id'}), (callee:Symbol {id: 'calcula-id'})
      CREATE (caller)-[:CALLS]->(callee)
    `)
    await client.execute(`
      MATCH (caller:Symbol {id: 'outro-id'}), (callee:Symbol {id: 'main-id'})
      CREATE (caller)-[:IMPORTS]->(callee)
    `)

    // 3. Executar o analisador de impacto
    const results = await analyzer.analyzeImpact('soma-id')

    // 4. Assercoes
    expect(results).toHaveLength(3)

    const calcula = results.find((r) => r.symbolId === 'calcula-id')
    expect(calcula).toBeDefined()
    expect(calcula!.name).toBe('calcula')
    expect(calcula!.filePath).toBe('src/calc.ts')
    expect(calcula!.type).toBe('function')
    expect(calcula!.depth).toBe(1)

    const main = results.find((r) => r.symbolId === 'main-id')
    expect(main).toBeDefined()
    expect(main!.name).toBe('main')
    expect(main!.filePath).toBe('src/main.ts')
    expect(main!.type).toBe('function')
    expect(main!.depth).toBe(2)

    const outro = results.find((r) => r.symbolId === 'outro-id')
    expect(outro).toBeDefined()
    expect(outro!.name).toBe('outro')
    expect(outro!.filePath).toBe('src/outro.ts')
    expect(outro!.type).toBe('function')
    expect(outro!.depth).toBe(3)
  })

  it('deve respeitar o limite maximo de profundidade (maxDepth)', async () => {
    await client.execute(`
      CREATE (s1:Symbol {id: 'soma-id', name: 'soma', filePath: 'src/math.ts', type: 'function', startLine: 1, endLine: 3, startCol: 1, endCol: 1})
    `)
    await client.execute(`
      CREATE (s2:Symbol {id: 'calcula-id', name: 'calcula', filePath: 'src/calc.ts', type: 'function', startLine: 1, endLine: 3, startCol: 1, endCol: 1})
    `)
    await client.execute(`
      CREATE (s3:Symbol {id: 'main-id', name: 'main', filePath: 'src/main.ts', type: 'function', startLine: 1, endLine: 3, startCol: 1, endCol: 1})
    `)

    await client.execute(`
      MATCH (caller:Symbol {id: 'calcula-id'}), (callee:Symbol {id: 'soma-id'})
      CREATE (caller)-[:CALLS]->(callee)
    `)
    await client.execute(`
      MATCH (caller:Symbol {id: 'main-id'}), (callee:Symbol {id: 'calcula-id'})
      CREATE (caller)-[:CALLS]->(callee)
    `)

    const results = await analyzer.analyzeImpact('soma-id', 1)
    expect(results).toHaveLength(1)
    expect(results[0]!.symbolId).toBe('calcula-id')
  })
})
