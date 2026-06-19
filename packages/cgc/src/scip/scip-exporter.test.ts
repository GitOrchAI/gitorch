import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { KuzuClient } from '../db/kuzu-client'
import { TreeSitterManager } from '../parser/tree-sitter-manager'
import { CodeGraphIndexer } from '../core/indexer'
import { ScipExporter } from './scip-exporter'

describe('ScipExporter', () => {
  let client: KuzuClient
  let manager: TreeSitterManager
  let indexer: CodeGraphIndexer
  let exporter: ScipExporter

  beforeAll(async () => {
    client = new KuzuClient(':memory:')
    await client.init()
    manager = new TreeSitterManager()
    indexer = new CodeGraphIndexer(client, manager)
    await indexer.initializeSchema()
    exporter = new ScipExporter(client)
  })

  afterAll(async () => {
    await client.close()
  })

  beforeEach(async () => {
    try {
      await client.execute('MATCH (n) DETACH DELETE n')
    } catch (e) {
      // Ignorar se o banco ainda não contiver dados
    }
  })

  it('deve exportar um index SCIP completo contendo arquivos, simbolos e relacionamentos', async () => {
    // 1. Indexar arquivo de biblioteca (math.ts) contendo uma função e uma classe
    const mathCode = `export function somar(a: number, b: number): number {
  return a + b;
}
export class Calculadora {
  calcular(x: number): number {
    return x;
  }
}`
    await indexer.indexFile('src/math.ts', mathCode, 'typescript')

    // 2. Indexar arquivo de entrada (main.ts) contendo import e chamada de função
    const mainCode = `import { somar } from './math';
function main() {
  const resultado = somar(2, 3);
}`
    await indexer.indexFile('src/main.ts', mainCode, 'typescript')

    // 3. Exportar para SCIP
    const index = await exporter.export({ projectRoot: 'cgc://' })

    // 4. Validar estrutura root do SCIP
    expect(index).toBeDefined()
    expect(index.metadata).toBeDefined()
    expect(index.metadata.toolInfo).toBeDefined()
    expect(index.metadata.toolInfo?.name).toBe('gitorch-cgc')
    expect(index.documents).toHaveLength(2)

    // Ordenar documentos pelo relative_path para asserções determinísticas
    const sortedDocs = [...index.documents].sort((a, b) =>
      a.relative_path.localeCompare(b.relative_path)
    )
    const mainDoc = sortedDocs.find((d) => d.relative_path === 'src/main.ts')
    const mathDoc = sortedDocs.find((d) => d.relative_path === 'src/math.ts')

    expect(mainDoc).toBeDefined()
    expect(mathDoc).toBeDefined()

    // 5. Validar o documento math.ts
    // Deve conter símbolos: 'somar' (função), 'Calculadora' (classe), e 'calcular' (método)
    // E suas respectivas occurrences de definição (role 1)
    expect(mathDoc?.language).toBe('typescript')
    expect(mathDoc?.symbols).toHaveLength(3)

    const somarSymbolInfo = mathDoc?.symbols.find((s) => s.symbol.includes('somar'))
    const calculadoraSymbolInfo = mathDoc?.symbols.find((s) => s.symbol.includes('Calculadora'))
    const calcularSymbolInfo = mathDoc?.symbols.find((s) => s.symbol.includes('calcular'))

    expect(somarSymbolInfo).toBeDefined()
    expect(somarSymbolInfo?.kind).toBe(16) // Function Kind

    expect(calculadoraSymbolInfo).toBeDefined()
    expect(calculadoraSymbolInfo?.kind).toBe(7) // Class Kind

    expect(calcularSymbolInfo).toBeDefined()
    expect(calcularSymbolInfo?.kind).toBe(23) // Method Kind

    // Verificar occurrences de definição
    expect(mathDoc?.occurrences.length).toBeGreaterThanOrEqual(3)
    const somarDef = mathDoc?.occurrences.find(
      (o) => o.symbol.includes('somar') && o.symbol_roles === 1
    )
    expect(somarDef).toBeDefined()
    // range original no Kuzu: startLine 1, startCol 7, endLine 3, endCol 1 (cobre a declaração da função inteira)
    // em SCIP (0-indexed para linhas e colunas):
    // startLine = 0, startCol = 7, endLine = 2, endCol = 1
    expect(somarDef?.range).toEqual([0, 7, 2, 1])

    // 6. Validar o documento main.ts
    // Deve conter occurrences de import (role 2) ou referência, e de chamada
    expect(mainDoc?.occurrences.length).toBeGreaterThanOrEqual(2)

    // Deve conter a definição da função main (role 1)
    const mainDef = mainDoc?.occurrences.find(
      (o) => o.symbol.includes('main') && o.symbol_roles === 1
    )
    expect(mainDef).toBeDefined()

    // Deve conter a referência/chamada para somar
    const somarCall = mainDoc?.occurrences.find(
      (o) => o.symbol.includes('somar') && o.symbol_roles !== 1
    )
    expect(somarCall).toBeDefined()
  })
})
