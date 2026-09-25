import { KuzuClient } from './db/kuzu-client.js'
import { TreeSitterManager, WasmPoisonError } from './parser/tree-sitter-manager.js'
import { CodeGraphIndexer } from './core/indexer.js'
import {
  collectSourceFiles,
  PoisonedFileError,
  type SummarizeOptions,
  type WorkspaceIndexAnalysis,
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
  repositoryId?: string
}

export interface GraphExportEdge {
  source: string
  target: string
  rel: 'CALLS' | 'IMPORTS' | 'CONTAINS' | 'CROSS_REPO_DEPENDS_ON' | 'CALLS_CONTRACT'
  repositoryId?: string
}

export interface GraphExportResult {
  nodes: GraphExportNode[]
  edges: GraphExportEdge[]
  truncated: boolean
  aggregatedBy?: 'directory'
  moduleGraph?: {
    nodes: Array<{ id: string; file: string; type: 'file' }>
    edges: Array<{ source: string; target: string; rel: 'IMPORTS' }>
  }
  metrics: {
    symbolCount: number
    orphanNodes: number
    structuralComplexity: number
  }
  promptFormatted: string
}

function formatGraphForPrompt(nodes: GraphExportNode[], edges: GraphExportEdge[]): string {
  const lines: string[] = []
  lines.push('--- Code Graph ---')
  if (nodes.length === 0) {
    lines.push('Empty graph.')
    return lines.join('\n')
  }

  const nodesById = new Map<string, GraphExportNode>()
  const outgoing = new Map<string, Array<{ target: string; rel: string }>>()
  for (const n of nodes) {
    nodesById.set(n.id, n)
    outgoing.set(n.id, [])
  }
  for (const e of edges) {
    if (outgoing.has(e.source)) {
      outgoing.get(e.source)!.push({ target: e.target, rel: e.rel })
    }
  }

  // Agrupa os nós por arquivo ou diretório
  const byContainer = new Map<string, GraphExportNode[]>()
  for (const n of nodes) {
    const list = byContainer.get(n.file) ?? []
    list.push(n)
    byContainer.set(n.file, list)
  }

  for (const [container, containerNodes] of [...byContainer.entries()].sort()) {
    lines.push(`\n[${container}]`)
    for (const n of containerNodes.sort((a, b) => a.label.localeCompare(b.label))) {
      lines.push(`  - ${n.label} (${n.type}) [health: ${n.health}]`)
      const out = outgoing.get(n.id) ?? []
      if (out.length > 0) {
        // Formata chamadas de forma concisa (ex: CALLS alvo1, alvo2)
        const calls = out
          .filter((e) => e.rel === 'CALLS')
          .map((e) => nodesById.get(e.target)?.label ?? e.target)
        if (calls.length > 0) {
          lines.push(`    -> CALLS: ${calls.join(', ')}`)
        }
      }
    }
  }
  return lines.join('\n')
}

export interface ExportGraphOptions extends SummarizeOptions {
  /** Teto de nós antes de agregar por diretório. Default 1500 (spec Onda 3). */
  maxNodes?: number
}

export interface MultiRepoExportInput {
  repositoryId: string
  workspacePath: string
  summary?: WorkspaceIndexAnalysis
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
  input: string | MultiRepoExportInput[],
  options: ExportGraphOptions = {}
): Promise<GraphExportResult | null> {
  const maxNodes = options.maxNodes ?? 1500
  const maxFiles = options.maxFiles ?? 100
  const maxFileBytes = options.maxFileBytes ?? 400_000
  const excluded = new Set(options.excludeFiles ?? [])

  const repos: MultiRepoExportInput[] =
    typeof input === 'string'
      ? [{ repositoryId: '', workspacePath: input, summary: undefined }]
      : input

  if (repos.length === 0) return null

  let client: KuzuClient | undefined
  let manager: TreeSitterManager | undefined
  try {
    client = new KuzuClient(':memory:')
    manager = new TreeSitterManager()
    const indexer = new CodeGraphIndexer(client, manager)
    await indexer.initializeSchema()

    const allSources = []
    let hasSources = false

    for (const repo of repos) {
      const sources = collectSourceFiles(repo.workspacePath, maxFiles, maxFileBytes).filter(
        (f) => !excluded.has(f.relPath)
      )

      for (const file of sources) {
        hasSources = true
        try {
          await indexer.indexFile(file.relPath, file.content, file.language, repo.repositoryId)
        } catch (err) {
          if (err instanceof WasmPoisonError) throw new PoisonedFileError(file.relPath)
          /* arquivo problemático (não-veneno) não derruba o export inteiro */
        }
      }

      allSources.push(...sources)
    }

    if (!hasSources) return null

    const untested = new Set(computeUntestedModules(allSources))

    // Insere arestas cross-repo baseadas nos sumários extraídos (heurísticas)
    // Para simplificar, processamos essas informações no nível da memória do KuzuDB agora.
    for (const repo of repos) {
      if (!repo.summary) continue

      // We must handle `../repoA/src/backend.ts` correctly by resolving it
      const resolvePath = (p: string) => {
        if (p.startsWith('../')) {
          const parts = p.substring(3).split('/')
          const repoId = parts[0]
          const filePath = parts.slice(1).join('/')
          return `cgc://${repoId}/${filePath}`
        }
        return repo.repositoryId ? `cgc://${repo.repositoryId}/${p}` : `cgc://${p}`
      }

      // Shared Routes (Backend/Frontend APIs) -> CALLS_CONTRACT
      for (const route of repo.summary.sharedRoutes || []) {
        const beId = resolvePath(route.backendFile)
        const feId = resolvePath(route.frontendFile)
        // A aresta "CALLS_CONTRACT" representa o fluxo frontend chamando backend
        await client.execute(
          `MERGE (fe:File {id: $feId})
           MERGE (be:File {id: $beId})
           MERGE (fe)-[:CALLS_CONTRACT]->(be)`,
          { feId, beId }
        )
      }

      // Shared Models (DB Schema/Backend APIs) -> CROSS_REPO_DEPENDS_ON
      for (const model of repo.summary.sharedModels || []) {
        const dbId = resolvePath(model.dbFile)
        const beId = resolvePath(model.backendFile)
        await client.execute(
          `MERGE (be:File {id: $beId})
           MERGE (db:File {id: $dbId})
           MERGE (be)-[:CROSS_REPO_DEPENDS_ON]->(db)`,
          { beId, dbId }
        )
      }

      // Cross Package Dependencies -> CROSS_REPO_DEPENDS_ON
      for (const edge of repo.summary.crossPackageDependencies || []) {
        const sourceId = resolvePath(edge.source)
        const targetId = resolvePath(edge.target)
        await client.execute(
          `MERGE (s:File {id: $sourceId})
           MERGE (t:File {id: $targetId})
           MERGE (s)-[:CROSS_REPO_DEPENDS_ON]->(t)`,
          { sourceId, targetId }
        )
      }
    }

    // Símbolos "import" são ruído visual (placeholders internos do indexer,
    // não código real do repo) — nunca viram NÓ. Mas uma chamada cross-file
    // (`main.ts` chama `somar` importado de `math.ts`) é indexada como
    // `main CALLS <placeholder import>` + `<placeholder import> IMPORTS
    // math.ts#somar` (ver indexer.ts). Sem resolver esse 1 hop, a aresta
    // CALLS aponta para um nó que não existe no export — o grafo perderia
    // toda chamada entre arquivos, que é justamente o caso mais comum.
    const symbolRows = (await client.query(
      'MATCH (s:Symbol) RETURN s.id AS id, s.name AS name, s.type AS type, s.filePath AS filePath, s.repositoryId AS repositoryId'
    )) as Array<{ id: string; name: string; type: string; filePath: string; repositoryId?: string }>
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
        repositoryId: s.repositoryId,
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

    // Arestas de nível de arquivo
    const crossRepoDependsOnRows = (await client.query(
      'MATCH (a:File)-[:CROSS_REPO_DEPENDS_ON]->(b:File) RETURN a.id AS source, b.id AS target'
    )) as Array<{ source: string; target: string }>
    for (const r of crossRepoDependsOnRows) {
      edges.push({ source: r.source, target: r.target, rel: 'CROSS_REPO_DEPENDS_ON' })
    }

    const callsContractRows = (await client.query(
      'MATCH (a:File)-[:CALLS_CONTRACT]->(b:File) RETURN a.id AS source, b.id AS target'
    )) as Array<{ source: string; target: string }>
    for (const r of callsContractRows) {
      edges.push({ source: r.source, target: r.target, rel: 'CALLS_CONTRACT' })
    }

    // Injetamos um nó temporário para `File` na lista de nodes se não estiver presente
    // mas for referenciado, para o Graph desenhar corretamente.
    const fileNodeSet = new Set(nodes.map((n) => n.id))
    const extractFileNodes = async (edgesArr: GraphExportEdge[]) => {
      for (const edge of edgesArr) {
        if (edge.rel === 'CROSS_REPO_DEPENDS_ON' || edge.rel === 'CALLS_CONTRACT') {
          for (const id of [edge.source, edge.target]) {
            if (!fileNodeSet.has(id)) {
              // Extract repository ID and file path
              const idStr = id.startsWith('cgc://') ? id.slice(6) : id
              let repoId = ''
              let filePath = idStr
              const splitIndex = idStr.indexOf('/')
              if (splitIndex !== -1 && splitIndex < idStr.length - 1 && idStr.includes('/')) {
                repoId = idStr.substring(0, splitIndex)
                filePath = idStr.substring(splitIndex + 1)
              }

              nodes.push({
                id,
                label: filePath.split('/').pop() || filePath,
                file: filePath,
                type: 'file',
                health: 'good',
                repositoryId: repoId || undefined,
              })
              fileNodeSet.add(id)
            }
          }
        }
      }
    }
    await extractFileNodes(edges)

    const orphanNodes = nodes.filter((n) => (fanIn.get(n.id) ?? 0) === 0).length
    const symbolCount = nodes.length
    const structuralComplexity = symbolCount > 0 ? edges.length / symbolCount : 0
    const metrics = { symbolCount, orphanNodes, structuralComplexity }

    const moduleGraphNodes = allSources.map((s) => ({
      id: `file://${s.relPath}`,
      file: s.relPath,
      type: 'file' as const,
    }))
    const moduleGraphEdges: Array<{ source: string; target: string; rel: 'IMPORTS' }> = []

    // A file imports another file if any of its symbols imports a symbol from the other file.
    const fileImports = new Set<string>()
    for (const r of importResolveRows) {
      const impSym = symbolById.get(r.impId)
      const srcSym = symbolById.get(r.srcId)
      if (impSym && srcSym && impSym.filePath !== srcSym.filePath) {
        const key = `${impSym.filePath}->${srcSym.filePath}`
        if (!fileImports.has(key)) {
          fileImports.add(key)
          moduleGraphEdges.push({
            source: `file://${impSym.filePath}`,
            target: `file://${srcSym.filePath}`,
            rel: 'IMPORTS',
          })
        }
      }
    }
    const moduleGraph = { nodes: moduleGraphNodes, edges: moduleGraphEdges }

    if (nodes.length > maxNodes) {
      const agg = aggregateByDirectory(nodes, edges, maxNodes)
      return {
        nodes: agg.nodes,
        edges: agg.edges,
        truncated: true,
        aggregatedBy: 'directory',
        metrics,
        moduleGraph,
        promptFormatted: formatGraphForPrompt(agg.nodes, agg.edges),
      }
    }

    return {
      nodes,
      edges,
      truncated: false,
      metrics,
      moduleGraph,
      promptFormatted: formatGraphForPrompt(nodes, edges),
    }
  } catch (err) {
    if (err instanceof PoisonedFileError) throw err
    return null
  } finally {
    // dispose ANTES do close: solta o WASM do parser enquanto o processo
    // ainda esta estavel, em vez de deixar o objeto vivo para o finalizador
    // do GC rodar em momento arbitrario (causa medida de "Worker exited
    // unexpectedly" no vitest — ver tree-sitter-manager.ts).
    if (manager) {
      manager.dispose()
    }
    if (client) {
      try {
        await client.close()
      } catch {
        /* ignore */
      }
    }
  }
}
