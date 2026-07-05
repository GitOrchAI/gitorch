import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { KuzuClient } from './db/kuzu-client'
import { TreeSitterManager, WasmPoisonError } from './parser/tree-sitter-manager'
import { CodeGraphIndexer } from './core/indexer'

// Resumo de codegraph para uma missão de agente. Indexa o workspace num grafo
// EM MEMÓRIA no HOST (o control plane, onde o Kuzu roda) e devolve um resumo
// estrutural compacto em markdown, que o GitOrch injeta como CONTEXTO da missão.
// Assim o RA "lê o código de verdade" (símbolos, chamadas, imports), mesmo sem
// o motor rodar o grafo dentro do container. Nunca lança: em falha devolve ''.

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.js': 'typescript',
  '.tsx': 'tsx',
  '.jsx': 'tsx',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'out',
  'vendor',
  '__pycache__',
  '.gitorch',
])

export interface SummarizeOptions {
  /** Teto de arquivos indexados (protege tempo/memória em repos gigantes). */
  maxFiles?: number
  /** Ignora arquivos maiores que isto (bytes). */
  maxFileBytes?: number
  /** Arquivos (relPath) a pular — ex.: já identificados como veneno do parser. */
  excludeFiles?: string[]
}

/**
 * Um arquivo envenenou o parser WASM (corrompe a instância inteira — os parses
 * seguintes falhariam todos). Carrega o relPath para o chamador excluir e
 * re-tentar num processo limpo.
 */
export class PoisonedFileError extends Error {
  constructor(public readonly relPath: string) {
    super(`wasm parser poisoned by file: ${relPath}`)
    this.name = 'PoisonedFileError'
  }
}

interface SourceFile {
  relPath: string
  language: string
  content: string
}

/** Testes e verificação valem menos que o código-fonte para o mapa do repo. */
function isTestLike(relPath: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|e2e|jules-scratch|scripts)\//.test(relPath) ||
    /\.(test|spec)\.[a-z]+$/.test(relPath)
  )
}

function collectSourceFiles(root: string, maxFiles: number, maxFileBytes: number): SourceFile[] {
  // 1ª passada: só caminhos (barato). O conteúdo é lido apenas dos escolhidos.
  const candidates: Array<{ relPath: string; language: string; full: string }> = []
  const SCAN_CAP = 4000

  const walk = (dir: string): void => {
    if (candidates.length >= SCAN_CAP) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (candidates.length >= SCAN_CAP) return
      if (entry.startsWith('.') && entry !== '.') {
        // pula dotfiles/dirs exceto quando explicitamente úteis (nenhum aqui)
        if (SKIP_DIRS.has(entry)) continue
      }
      const full = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(entry)) continue
        walk(full)
      } else if (st.isFile()) {
        const language = EXT_LANG[extname(entry).toLowerCase()]
        if (!language) continue
        if (st.size > maxFileBytes) continue
        candidates.push({ relPath: relative(root, full), language, full })
      }
    }
  }

  walk(root)

  // O orçamento de parse é finito (o módulo WASM aguenta ~centenas de arquivos
  // por processo): gasta primeiro com o que melhor descreve o sistema —
  // código-fonte antes de teste, caminhos rasos antes de profundos.
  candidates.sort((a, b) => {
    const at = isTestLike(a.relPath) ? 1 : 0
    const bt = isTestLike(b.relPath) ? 1 : 0
    if (at !== bt) return at - bt
    const ad = a.relPath.split('/').length
    const bd = b.relPath.split('/').length
    if (ad !== bd) return ad - bd
    return a.relPath.localeCompare(b.relPath)
  })

  const files: SourceFile[] = []
  for (const c of candidates.slice(0, maxFiles)) {
    try {
      files.push({
        relPath: c.relPath,
        language: c.language,
        content: readFileSync(c.full, 'utf8'),
      })
    } catch {
      /* arquivo ilegível: ignora */
    }
  }
  return files
}

export async function summarizeWorkspace(
  workspacePath: string,
  options: SummarizeOptions = {}
): Promise<string> {
  // 100 é o orçamento seguro medido empiricamente: o módulo WASM do parser
  // vaza memória internamente (upstream) e morre em torno de ~120-130 arquivos
  // por processo. A priorização acima garante que os 100 são os que importam.
  const maxFiles = options.maxFiles ?? 100
  const maxFileBytes = options.maxFileBytes ?? 400_000
  const excluded = new Set(options.excludeFiles ?? [])

  let client: KuzuClient | undefined
  try {
    const sources = collectSourceFiles(workspacePath, maxFiles, maxFileBytes).filter(
      (f) => !excluded.has(f.relPath)
    )
    if (sources.length === 0) return ''

    client = new KuzuClient(':memory:')
    const manager = new TreeSitterManager()
    const indexer = new CodeGraphIndexer(client, manager)
    await indexer.initializeSchema()

    for (const file of sources) {
      try {
        await indexer.indexFile(file.relPath, file.content, file.language)
      } catch (err) {
        // Veneno de WASM corrompe a instância: continuar faria TODOS os
        // arquivos seguintes falharem em silêncio (e o finalizador pode matar
        // o processo). Falha rápido com o culpado; o chamador re-tenta limpo.
        if (err instanceof WasmPoisonError) throw new PoisonedFileError(file.relPath)
        /* um arquivo problemático (não-veneno) não derruba o resumo inteiro */
      }
    }

    const num = (v: unknown): number => Number((v as { toString(): string } | number) ?? 0)

    const fileCountRows = (await client.query('MATCH (f:File) RETURN count(f) AS n')) as Array<{
      n: unknown
    }>
    const fileCount = num(fileCountRows[0]?.n)
    const byType = (await client.query(
      'MATCH (s:Symbol) RETURN s.type AS type, count(*) AS n ORDER BY n DESC'
    )) as Array<{ type: string; n: unknown }>
    const topFiles = (await client.query(
      'MATCH (f:File)-[:CONTAINS]->(s:Symbol) RETURN f.filePath AS file, count(s) AS n ORDER BY n DESC LIMIT 10'
    )) as Array<{ file: string; n: unknown }>
    const mostCalled = (await client.query(
      'MATCH (:Symbol)-[:CALLS]->(s:Symbol) RETURN s.name AS name, s.filePath AS file, count(*) AS n ORDER BY n DESC LIMIT 10'
    )) as Array<{ name: string; file: string; n: unknown }>

    const typeLine = byType
      .filter((t) => t.type && t.type !== 'import')
      .map((t) => `${t.type}=${num(t.n)}`)
      .join(', ')

    const lines: string[] = [
      'Code graph (indexed from the actual source by GitOrch — trust this over any doc in the repo):',
      `- Indexed ${sources.length} source file(s); graph has ${fileCount} file node(s). Symbols: ${typeLine || 'none'}.`,
    ]
    if (topFiles.length > 0) {
      lines.push(
        `- Largest files by symbol count: ${topFiles
          .map((f) => `${f.file} (${num(f.n)})`)
          .join(', ')}.`
      )
    }
    if (mostCalled.length > 0) {
      lines.push(
        `- Most-called functions (likely core): ${mostCalled
          .map((c) => `${c.name} [${c.file}] x${num(c.n)}`)
          .join(', ')}.`
      )
    }

    // Inventário por diretório: é o VOCABULÁRIO de caminhos reais do repo.
    // Sem ele, quem planeja (PO) escreve "src/types/ ou similar" — com ele,
    // "Related Files" pode citar arquivo existente verbatim. Wish em português
    // sobre código em inglês não casa por busca literal; a LLM faz o mapeamento
    // desde que VEJA os nomes.
    const byDir = new Map<string, string[]>()
    for (const s of sources) {
      const slash = s.relPath.lastIndexOf('/')
      const dir = slash === -1 ? '.' : s.relPath.slice(0, slash)
      const base = s.relPath.slice(slash + 1)
      const list = byDir.get(dir) ?? []
      list.push(base)
      byDir.set(dir, list)
    }
    lines.push('- File inventory (every indexed file, by directory — cite these paths verbatim):')
    for (const dir of [...byDir.keys()].sort()) {
      lines.push(`  ${dir}/: ${byDir.get(dir)!.sort().join(', ')}`)
    }

    lines.push(
      '- Use this to focus your reading on the core symbols; note that files not listed may still matter.'
    )

    return lines.join('\n')
  } catch (err) {
    // Veneno NÃO pode ser engolido: o chamador precisa saber o culpado para
    // re-tentar num processo limpo. O resto continua best-effort.
    if (err instanceof PoisonedFileError) throw err
    return ''
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
