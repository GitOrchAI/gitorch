import { KuzuClient } from '../db/kuzu-client'

export interface ScipMetadata {
  projectRoot: string
  toolInfo: {
    name: string
    version: string
  }
}

export interface ScipOccurrence {
  range: number[]
  symbol: string
  symbol_roles: number
}

export interface ScipSymbolInformation {
  symbol: string
  documentation?: string[]
  kind: number
}

export interface ScipDocument {
  language: string
  relative_path: string
  occurrences: ScipOccurrence[]
  symbols: ScipSymbolInformation[]
}

export interface ScipIndex {
  metadata: ScipMetadata
  documents: ScipDocument[]
}

export class ScipExporter {
  constructor(private client: KuzuClient) {}

  async export(options?: { projectRoot?: string }): Promise<ScipIndex> {
    const projectRoot = options?.projectRoot || 'cgc://'

    // Executa as queries concorrentemente para otimizar performance
    const [filesRows, symbolsRows, importsRows] = await Promise.all([
      this.client.query('MATCH (f:File) RETURN f.id AS id, f.filePath AS filePath'),
      this.client.query(
        'MATCH (s:Symbol) RETURN s.id AS id, s.name AS name, s.type AS type, s.filePath AS filePath, s.startLine AS startLine, s.endLine AS endLine, s.startCol AS startCol, s.endCol AS endCol'
      ),
      this.client.query(
        "MATCH (local:Symbol {type: 'import'})-[:IMPORTS]->(source:Symbol) RETURN local.id AS localId, source.id AS sourceId"
      ),
    ])

    // Dicionário de tipos de símbolos para resolver os escopos
    const symbolTypes = new Map<string, string>()
    for (const s of symbolsRows) {
      symbolTypes.set(s['id'] as string, s['type'] as string)
    }

    // Dicionário de mapeamento de imports para os seus symbols de origem
    const importTargets = new Map<string, string>()
    for (const imp of importsRows) {
      importTargets.set(imp['localId'] as string, imp['sourceId'] as string)
    }

    // Agrupamento eficiente O(S) de símbolos por arquivo para lookup O(1) posterior
    const symbolsByFile = new Map<string, typeof symbolsRows>()
    for (const s of symbolsRows) {
      const filePath = s['filePath'] as string
      if (!symbolsByFile.has(filePath)) {
        symbolsByFile.set(filePath, [])
      }
      symbolsByFile.get(filePath)!.push(s)
    }

    // Função auxiliar para parsear ID do Kuzu
    const parseKuzuId = (id: string) => {
      const prefix = 'cgc://'
      if (!id.startsWith(prefix)) return null
      const withoutPrefix = id.slice(prefix.length)
      const hashIdx = withoutPrefix.indexOf('#')
      if (hashIdx === -1) {
        return { filePath: withoutPrefix, scopes: [] }
      }
      const filePath = withoutPrefix.slice(0, hashIdx)
      const scopeStr = withoutPrefix.slice(hashIdx + 1)
      const scopes = scopeStr.split('.')
      return { filePath, scopes }
    }

    // Função de formatação do SCIP symbol com prevenção de loops cíclicos
    const getScipSymbol = (
      kuzuId: string,
      projectRoot: string,
      visited = new Set<string>()
    ): string => {
      if (visited.has(kuzuId)) {
        return kuzuId
      }
      visited.add(kuzuId)

      // Se for um import, e tiver target resolvido, usa o do target
      const targetId = importTargets.get(kuzuId)
      if (targetId) {
        return getScipSymbol(targetId, projectRoot, visited)
      }

      const parsed = parseKuzuId(kuzuId)
      if (!parsed) return kuzuId

      const { filePath, scopes } = parsed

      let displayFilePath = filePath
      if (projectRoot && displayFilePath.startsWith(projectRoot)) {
        displayFilePath = displayFilePath.slice(projectRoot.length)
      }
      displayFilePath = displayFilePath.replace(/^[/\\]+/, '').replace(/\\/g, '/')
      let scipStr = `scip-typescript npm @gitorch/cgc 0.1.0 \`${displayFilePath}\`/`

      const currentPathScopes: string[] = []
      for (const scopeName of scopes) {
        currentPathScopes.push(scopeName)
        const partialId = `cgc://${filePath}#${currentPathScopes.join('.')}`
        const type = symbolTypes.get(partialId) || 'variable'

        let suffix = '.'
        if (type === 'class' || type === 'interface' || type === 'type') {
          suffix = '#'
        } else if (type === 'function' || type === 'method') {
          suffix = '().'
        }
        scipStr += `${scopeName}${suffix}`
      }

      return scipStr
    }

    // Função para inferir linguagem
    const getLanguage = (filePath: string): string => {
      if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript'
      if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'javascript'
      return 'typescript' // default
    }

    const documents: ScipDocument[] = []

    for (const fileRow of filesRows) {
      const filePath = fileRow['filePath'] as string

      // Calcular o caminho relativo
      let relativePath = filePath
      if (filePath.startsWith(projectRoot)) {
        relativePath = filePath.slice(projectRoot.length)
      }
      // Remove quaisquer barras (/ ou \) duplicadas ou à esquerda indesejadas
      relativePath = relativePath.replace(/^[/\\]+/, '')
      relativePath = relativePath.replace(/\\/g, '/')

      // Símbolos pertencentes a este arquivo obtidos via lookup O(1)
      const fileSymbols = symbolsByFile.get(filePath) || []

      const occurrences: ScipOccurrence[] = []
      const symbols: ScipSymbolInformation[] = []

      for (const sym of fileSymbols) {
        const symId = sym['id'] as string
        const symType = sym['type'] as string
        const scipSymbol = getScipSymbol(symId, projectRoot)

        // Range: startLine, startCol, endLine, endCol (0-indexed para linhas no SCIP)
        const startLine = Number(sym['startLine']) - 1
        const startCol = Number(sym['startCol'])
        const endLine = Number(sym['endLine']) - 1
        const endCol = Number(sym['endCol'])

        // Definir role: 1 para Definition, 2 para Import (se for do tipo import)
        let role = 1
        if (symType === 'import') {
          role = 2
        }

        occurrences.push({
          range: [startLine, startCol, endLine, endCol],
          symbol: scipSymbol,
          symbol_roles: role,
        })

        // Apenas gerar SymbolInformation para símbolos que definimos localmente no arquivo (não para imports de fora)
        if (symType !== 'import') {
          let kind = 0
          switch (symType) {
            case 'class':
              kind = 7
              break
            case 'interface':
              kind = 18
              break
            case 'type':
              kind = 36
              break
            case 'function':
              kind = 16
              break
            case 'method':
              kind = 23
              break
            case 'variable':
              kind = 39
              break
          }

          symbols.push({
            symbol: scipSymbol,
            kind,
          })
        }
      }

      documents.push({
        language: getLanguage(filePath),
        relative_path: relativePath,
        occurrences,
        symbols,
      })
    }

    return {
      metadata: {
        projectRoot,
        toolInfo: {
          name: 'gitorch-cgc',
          version: '0.1.0',
        },
      },
      documents,
    }
  }
}
