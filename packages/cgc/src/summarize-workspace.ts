import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'
import { KuzuClient } from './db/kuzu-client'
import { TreeSitterManager } from './parser/tree-sitter-manager'
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
}

interface SourceFile {
  relPath: string
  language: string
  content: string
}

function collectSourceFiles(root: string, maxFiles: number, maxFileBytes: number): SourceFile[] {
  const files: SourceFile[] = []

  const walk = (dir: string): void => {
    if (files.length >= maxFiles) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return
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
        try {
          files.push({ relPath: relative(root, full), language, content: readFileSync(full, 'utf8') })
        } catch {
          /* arquivo ilegível: ignora */
        }
      }
    }
  }

  walk(root)
  return files
}

export async function summarizeWorkspace(
  workspacePath: string,
  options: SummarizeOptions = {}
): Promise<string> {
  const maxFiles = options.maxFiles ?? 600
  const maxFileBytes = options.maxFileBytes ?? 400_000

  let client: KuzuClient | undefined
  try {
    const sources = collectSourceFiles(workspacePath, maxFiles, maxFileBytes)
    if (sources.length === 0) return ''

    client = new KuzuClient(':memory:')
    const manager = new TreeSitterManager()
    const indexer = new CodeGraphIndexer(client, manager)
    await indexer.initializeSchema()

    for (const file of sources) {
      try {
        await indexer.indexFile(file.relPath, file.content, file.language)
      } catch {
        /* um arquivo problemático não derruba o resumo inteiro */
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
    lines.push(
      '- Use this to focus your reading on the core symbols; note that files not listed may still matter.'
    )

    return lines.join('\n')
  } catch {
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
