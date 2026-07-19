import { KuzuClient } from './db/kuzu-client.js'
import { TreeSitterManager, WasmPoisonError } from './parser/tree-sitter-manager.js'
import { CodeGraphIndexer } from './core/indexer.js'
import {
  collectSourceFiles,
  PoisonedFileError,
  type SummarizeOptions,
} from './summarize-workspace.js'
import { computeUntestedModules } from './untested-modules.js'

// Grafo 3D interativo do diagnóstico (F1 — Onda 3). Reusa a MESMA indexação
// zero-LLM de analyzeWorkspace (summarize-workspace.ts) — coleta de arquivos,
// Kuzu em memória, tree-sitter — mas devolve os nós/arestas BRUTOS (não
// agregados em métricas) para o front desenhar. Roda no mesmo protocolo de
// isolamento de processo filho do diagnóstico (ver graph-export-child.ts no
// control-plane) porque o parser WASM pode morrer com erro incapturável.

export type NodeHealth = 'good' | 'warn' | 'bad'

export interface GraphExportNode {
  id: string
  label: string
  file: string
  type: string
  health: NodeHealth
}

export interface GraphExportEdge {
  source: string
  target: string
  rel: 'CALLS' | 'IMPORTS' | 'CONTAINS'
}

export interface GraphExportResult {
  nodes: GraphExportNode[]
  edges: GraphExportEdge[]
  truncated: boolean
  aggregatedBy?: 'directory'
}

export interface ExportGraphOptions extends SummarizeOptions {
  /** Teto de nós antes de agregar por diretório. Default 1500 (spec Onda 3). */
  maxNodes?: number
}

const dirOf = (filePath: string): string => {
  const slash = filePath.lastIndexOf('/')
  return slash === -1 ? '.' : filePath.slice(0, slash)
}

const WORST: Record<NodeHealth, number> = { good: 0, warn: 1, bad: 2 }
const worstHealth = (a: NodeHealth, b: NodeHealth): NodeHealth => (WORST[b] > WORST[a] ? b : a)

function aggregateByDirectory(
  nodes: GraphExportNode[],
  edges: GraphExportEdge[],
  maxNodes: number
): { nodes: GraphExportNode[]; edges: GraphExportEdge[] } {
  const idToDir = new Map<string, string>()
  const perDir = new Map<string, { count: number; health: NodeHealth }>()

  for (const n of nodes) {
    const dir = dirOf(n.file)
    idToDir.set(n.id, dir)
    const acc = perDir.get(dir) ?? { count: 0, health: 'good' as NodeHealth }
    acc.count += 1
    acc.health = worstHealth(acc.health, n.health)
    perDir.set(dir, acc)
  }

  // Diretórios com mais membros primeiro — se ainda assim sobrar mais que
  // maxNodes (monorepo com centenas de pastas), corta os menores.
  const dirNodes: GraphExportNode[] = [...perDir.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, Math.max(1, maxNodes))
    .map(([dir, acc]) => ({
      id: `dir://${dir}`,
      label: `${dir} (${acc.count})`,
      file: dir,
      type: 'directory',
      health: acc.health,
    }))
  const keptDirs = new Set(dirNodes.map((n) => n.file))

  const edgeKey = (source: string, target: string, rel: string): string =>
    `${source}->${target}:${rel}`
  const aggEdges = new Map<string, GraphExportEdge>()
  for (const e of edges) {
    const sd = idToDir.get(e.source)
    const td = idToDir.get(e.target)
    if (!sd || !td || sd === td) continue // sem self-loop sintético por diretório
    if (!keptDirs.has(sd) || !keptDirs.has(td)) continue
    const source = `dir://${sd}`
    const target = `dir://${td}`
    const key = edgeKey(source, target, e.rel)
    if (!aggEdges.has(key)) aggEdges.set(key, { source, target, rel: e.rel })
  }

  return { nodes: dirNodes, edges: [...aggEdges.values()] }
}

/**
 * Exporta o grafo de símbolos (nós+arestas) de um workspace já clonado, para
 * o `RepoGraph3D` desenhar. Nunca lança por falta de código-fonte (devolve
 * null); PoisonedFileError ainda propaga (o chamador isolado decide, mesmo
 * contrato de diagnoseWorkspaceStructural).
 */
export async function exportGraph(
  workspacePath: string,
  options: ExportGraphOptions = {}
): Promise<GraphExportResult | null> {
  const maxNodes = options.maxNodes ?? 1500
  const maxFiles = options.maxFiles ?? 100
  const maxFileBytes = options.maxFileBytes ?? 400_000
  const excluded = new Set(options.excludeFiles ?? [])

  let client: KuzuClient | undefined
  try {
    const sources = collectSourceFiles(workspacePath, maxFiles, maxFileBytes).filter(
      (f) => !excluded.has(f.relPath)
    )
    if (sources.length === 0) return null

    client = new KuzuClient(':memory:')
    const manager = new TreeSitterManager()
    const indexer = new CodeGraphIndexer(client, manager)
    await indexer.initializeSchema()

    for (const file of sources) {
      try {
        await indexer.indexFile(file.relPath, file.content, file.language)
      } catch (err) {
        if (err instanceof WasmPoisonError) throw new PoisonedFileError(file.relPath)
        /* arquivo problemático (não-veneno) não derruba o export inteiro */
      }
    }

    const untested = new Set(computeUntestedModules(sources))

    // Símbolos "import" são ruído visual (placeholders internos do indexer,
    // não código real do repo) — nunca viram NÓ. Mas uma chamada cross-file
    // (`main.ts` chama `somar` importado de `math.ts`) é indexada como
    // `main CALLS <placeholder import>` + `<placeholder import> IMPORTS
    // math.ts#somar` (ver indexer.ts). Sem resolver esse 1 hop, a aresta
    // CALLS aponta para um nó que não existe no export — o grafo perderia
    // toda chamada entre arquivos, que é justamente o caso mais comum.
    const symbolRows = (await client.query(
      'MATCH (s:Symbol) RETURN s.id AS id, s.name AS name, s.type AS type, s.filePath AS filePath'
    )) as Array<{ id: string; name: string; type: string; filePath: string }>
    const symbolById = new Map(symbolRows.map((s) => [s.id, s]))

    const importResolveRows = (await client.query(
      "MATCH (imp:Symbol {type: 'import'})-[:IMPORTS]->(src:Symbol) RETURN imp.id AS impId, src.id AS srcId"
    )) as Array<{ impId: string; srcId: string }>
    const resolveImport = new Map(importResolveRows.map((r) => [r.impId, r.srcId]))
    // Segue o encadeamento até achar um símbolo não-import (ou desistir se
    // não resolver — chamada para pacote externo, sem nó local correspondente).
    const resolve = (id: string): string => {
      let current = id
      const seen = new Set<string>()
      while (symbolById.get(current)?.type === 'import' && resolveImport.has(current)) {
        if (seen.has(current)) break // ciclo de import — nunca deveria acontecer, mas não trava
        seen.add(current)
        current = resolveImport.get(current)!
      }
      return current
    }

    const isRealSymbol = (id: string): boolean => symbolById.get(id)?.type !== 'import'

    const callRows = (await client.query(
      'MATCH (a:Symbol)-[:CALLS]->(b:Symbol) RETURN a.id AS source, b.id AS target'
    )) as Array<{ source: string; target: string }>
    const resolvedCalls = callRows
      .map((r) => ({ source: resolve(r.source), target: resolve(r.target) }))
      .filter((e) => e.source !== e.target && isRealSymbol(e.source) && isRealSymbol(e.target))

    const fanIn = new Map<string, number>()
    for (const e of resolvedCalls) fanIn.set(e.target, (fanIn.get(e.target) ?? 0) + 1)

    const health = (filePath: string, id: string): NodeHealth => {
      const isUntested = untested.has(filePath)
      const calls = fanIn.get(id) ?? 0
      if (isUntested && calls >= 3) return 'bad' // código quente e sem teste = maior risco
      if (isUntested || calls === 0) return 'warn' // sem teste, ou nunca referenciado (órfão)
      return 'good'
    }

    const nodes: GraphExportNode[] = symbolRows
      .filter((s) => s.type !== 'import')
      .map((s) => ({
        id: s.id,
        label: s.name,
        file: s.filePath,
        type: s.type,
        health: health(s.filePath, s.id),
      }))

    const edges: GraphExportEdge[] = resolvedCalls.map((e) => ({ ...e, rel: 'CALLS' as const }))

    const containsRows = (await client.query(
      'MATCH (a:Symbol)-[:CONTAINS]->(b:Symbol) RETURN a.id AS source, b.id AS target'
    )) as Array<{ source: string; target: string }>
    for (const r of containsRows) {
      if (isRealSymbol(r.source) && isRealSymbol(r.target)) {
        edges.push({ source: r.source, target: r.target, rel: 'CONTAINS' })
      }
    }

    if (nodes.length > maxNodes) {
      const agg = aggregateByDirectory(nodes, edges, maxNodes)
      return { nodes: agg.nodes, edges: agg.edges, truncated: true, aggregatedBy: 'directory' }
    }

    return { nodes, edges, truncated: false }
  } catch (err) {
    if (err instanceof PoisonedFileError) throw err
    return null
  } finally {
    if (client) {
      try {
        await client.close()
      } catch {
        /* ignore */
      }
    }
  }
}
