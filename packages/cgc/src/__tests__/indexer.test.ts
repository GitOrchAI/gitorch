import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { KuzuClient } from '../db/kuzu-client'
import { TreeSitterManager } from '../parser/tree-sitter-manager'
import { CodeGraphIndexer } from '../core/indexer'

describe('CodeGraphIndexer', () => {
  let client: KuzuClient
  let manager: TreeSitterManager
  let indexer: CodeGraphIndexer

  beforeAll(async () => {
    client = new KuzuClient(':memory:')
    manager = new TreeSitterManager()
    indexer = new CodeGraphIndexer(client, manager)
    await indexer.initializeSchema()
  })

  afterAll(async () => {
    await client.close()
  })

  beforeEach(async () => {
    // Clear all data before each test, keeping the schema intact
    try {
      await client.execute('MATCH (n) DETACH DELETE n')
    } catch (e) {
      // Ignore if table/schema is not fully initialized yet (though it is in beforeAll)
    }
  })

  it('should initialize database schema without throwing', async () => {
    // Schema is already initialized in beforeAll, checking if calling it again is safe
    await expect(indexer.initializeSchema()).resolves.not.toThrow()
  })

  it('should index a simple typescript function', async () => {
    const code = `function soma(a: number, b: number): number {
  return a + b;
}`
    const filePath = 'src/math.ts'
    await indexer.indexFile(filePath, code, 'typescript')

    // Verify File node
    const files = await client.query('MATCH (f:File) RETURN f.id AS id, f.filePath AS filePath')
    expect(files).toHaveLength(1)
    expect(files[0].filePath).toBe(filePath)

    // Verify Symbol node
    const symbols = await client.query(
      'MATCH (s:Symbol) RETURN s.id AS id, s.name AS name, s.type AS type, s.filePath AS filePath, s.startLine AS startLine'
    )
    expect(symbols).toHaveLength(1)
    expect(symbols[0].name).toBe('soma')
    expect(symbols[0].type).toBe('function')
    expect(symbols[0].filePath).toBe(filePath)
    expect(Number(symbols[0].startLine)).toBe(1) // 1-indexed

    // Verify CONTAINS relation
    const relations = await client.query(
      'MATCH (f:File)-[r:CONTAINS]->(s:Symbol) RETURN f.id AS fileId, s.id AS symbolId'
    )
    expect(relations).toHaveLength(1)
    expect(relations[0].fileId).toBe(files[0].id)
    expect(relations[0].symbolId).toBe(symbols[0].id)
  })

  it('should support idempotency when re-indexing the same file', async () => {
    const code = `function soma(a: number, b: number): number {
  return a + b;
}`
    const filePath = 'src/math.ts'

    // Index first time
    await indexer.indexFile(filePath, code, 'typescript')

    // Index second time (with same or slightly modified code)
    await indexer.indexFile(filePath, code, 'typescript')

    const files = await client.query('MATCH (f:File) RETURN f.filePath AS filePath')
    expect(files).toHaveLength(1)

    const symbols = await client.query('MATCH (s:Symbol) RETURN s.name AS name')
    expect(symbols).toHaveLength(1)
  })

  it('should index classes and methods with nested CONTAINS relation', async () => {
    const code = `class Calculadora {
  somar(a: number, b: number): number {
    return a + b;
  }
}`
    const filePath = 'src/calc.ts'
    await indexer.indexFile(filePath, code, 'typescript')

    const symbols = await client.query(
      'MATCH (s:Symbol) RETURN s.name AS name, s.type AS type ORDER BY s.name'
    )
    expect(symbols).toHaveLength(2)
    expect(symbols[0].name).toBe('Calculadora')
    expect(symbols[0].type).toBe('class')
    expect(symbols[1].name).toBe('somar')
    expect(symbols[1].type).toBe('method')

    // Verify Class contains Method
    const classContainsMethod = await client.query(
      "MATCH (c:Symbol {type: 'class'})-[:CONTAINS]->(m:Symbol {type: 'method'}) RETURN c.name AS className, m.name AS methodName"
    )
    expect(classContainsMethod).toHaveLength(1)
    expect(classContainsMethod[0].className).toBe('Calculadora')
    expect(classContainsMethod[0].methodName).toBe('somar')
  })

  it('should index imports and calls relationships', async () => {
    // 1. Index the imported file first
    const mathCode = `export function somar(a: number, b: number): number {
  return a + b;
}`
    await indexer.indexFile('src/math.ts', mathCode, 'typescript')

    // 2. Index the main file containing imports and calls
    const mainCode = `import { somar } from './math';
function main() {
  const x = somar(1, 2);
}`
    await indexer.indexFile('src/main.ts', mainCode, 'typescript')

    // Verify Import Symbol node
    const imports = await client.query(
      "MATCH (s:Symbol {type: 'import'}) RETURN s.name AS name, s.id AS id"
    )
    expect(imports).toHaveLength(1)
    expect(imports[0].name).toBe('somar')
    expect(imports[0].id).toBe('cgc://src/main.ts#somar')

    // Verify IMPORTS relation
    const importRels = await client.query(
      "MATCH (s1:Symbol {type: 'import'})-[:IMPORTS]->(s2:Symbol) RETURN s1.name AS importName, s2.name AS sourceName, s2.filePath AS sourcePath"
    )
    expect(importRels).toHaveLength(1)
    expect(importRels[0].importName).toBe('somar')
    expect(importRels[0].sourceName).toBe('somar')
    expect(importRels[0].sourcePath).toBe('src/math.ts')

    // Verify CALLS relation
    const callRels = await client.query(
      "MATCH (caller:Symbol {name: 'main'})-[:CALLS]->(callee:Symbol) RETURN caller.name AS callerName, callee.name AS calleeName"
    )
    expect(callRels).toHaveLength(1)
    expect(callRels[0].callerName).toBe('main')
    expect(callRels[0].calleeName).toBe('somar')
  })

  it('should handle edge case: empty file', async () => {
    const filePath = 'src/empty.ts'
    await indexer.indexFile(filePath, '', 'typescript')

    // File node should exist
    const files = await client.query('MATCH (f:File) RETURN f.filePath AS filePath')
    expect(files).toHaveLength(1)
    expect(files[0].filePath).toBe(filePath)

    // No Symbol nodes should be created
    const symbols = await client.query('MATCH (s:Symbol) RETURN s')
    expect(symbols).toHaveLength(0)
  })

  it('should handle edge case: invalid code syntax resiliently', async () => {
    const filePath = 'src/invalid.ts'
    const invalidCode = 'class { function ( }'

    // Parse should not fail, should execute resiliently
    await expect(indexer.indexFile(filePath, invalidCode, 'typescript')).resolves.not.toThrow()

    // File node should exist
    const files = await client.query('MATCH (f:File) RETURN f.filePath AS filePath')
    expect(files).toHaveLength(1)
  })

  it('should handle edge case: anonymous export functions', async () => {
    const filePath = 'src/anon.ts'
    const anonCode = 'export default () => {}'

    await indexer.indexFile(filePath, anonCode, 'typescript')

    const files = await client.query('MATCH (f:File) RETURN f.filePath AS filePath')
    expect(files).toHaveLength(1)
  })
})
