import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportGraph } from './export-graph.js'

describe('exportGraph', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cgc-graph-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    // Nomeado para que 'math.ts' seja indexado ANTES de 'user.ts' na ordenação
    // alfabética de collectSourceFiles: o indexer resolve IMPORTS num único
    // passe (MATCH exige que o símbolo-alvo já exista) — importar de um
    // arquivo ainda não indexado deixa a aresta sem resolver (limitação
    // conhecida e pré-existente do CodeGraphIndexer, fora do escopo desta
    // mudança; ver comentário em export-graph.ts sobre `resolve()`).
    writeFileSync(
      join(dir, 'src', 'math.ts'),
      'export function somar(a: number, b: number): number {\n  return a + b\n}\n'
    )
    writeFileSync(
      join(dir, 'src', 'user.ts'),
      "import { somar } from './math'\nfunction usar() {\n  return somar(1, 2)\n}\n"
    )
    writeFileSync(
      join(dir, 'src', 'user.test.ts'),
      "import { usar } from './user'\ntest('usar', () => { usar() })\n"
    )
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('devolve nós e arestas reais do repo, sem agregação (abaixo do teto)', async () => {
    const g = await exportGraph(dir)
    expect(g).not.toBeNull()
    expect(g!.truncated).toBe(false)
    expect(g!.aggregatedBy).toBeUndefined()

    // `somar` e `usar` viram nós de função; `import` nunca aparece (ruído).
    const somar = g!.nodes.find((n) => n.label === 'somar')
    const usar = g!.nodes.find((n) => n.label === 'usar')
    expect(somar).toBeDefined()
    expect(usar).toBeDefined()
    expect(g!.nodes.some((n) => n.type === 'import')).toBe(false)

    // usar CALLS somar (via import resolvido 1 hop) -> aresta real no export.
    expect(
      g!.edges.some((e) => e.source === usar!.id && e.target === somar!.id && e.rel === 'CALLS')
    ).toBe(true)

    // math.ts não tem teste correspondente -> untested -> health não é 'good'
    // quando também é chamado (fan-in >= 1); ao menos marca 'warn' por não-testado.
    expect(somar!.health).not.toBe('good')
    expect(somar!.file).toBe('src/math.ts')

    // Verifica as métricas do grafo bruto
    expect(g!.metrics).toBeDefined()
    expect(g!.metrics.symbolCount).toBeGreaterThan(0)
    expect(typeof g!.metrics.orphanNodes).toBe('number')
    expect(typeof g!.metrics.structuralComplexity).toBe('number')

    expect(g!.moduleGraph).toBeDefined()
    expect(g!.moduleGraph!.nodes.some((n) => n.file === 'src/math.ts' && n.type === 'file')).toBe(
      true
    )
    expect(
      g!.moduleGraph!.edges.some(
        (e) =>
          e.source === 'file://src/user.ts' &&
          e.target === 'file://src/math.ts' &&
          e.rel === 'IMPORTS'
      )
    ).toBe(true)

    // Verifica a formatação textual
    expect(g!.promptFormatted).toBeDefined()
    expect(typeof g!.promptFormatted).toBe('string')
    expect(g!.promptFormatted.length).toBeGreaterThan(0)
    expect(g!.promptFormatted).toContain('--- Code Graph ---')
    expect(g!.promptFormatted).toContain('somar')
    expect(g!.promptFormatted).toContain('CALLS: somar')
  })

  it('agrega por diretório quando o grafo bruto excede maxNodes', async () => {
    const g = await exportGraph(dir, { maxNodes: 1 })
    expect(g).not.toBeNull()
    expect(g!.truncated).toBe(true)
    expect(g!.metrics).toBeDefined()
    expect(g!.aggregatedBy).toBe('directory')
    expect(g!.nodes.every((n) => n.type === 'directory')).toBe(true)
    expect(g!.nodes.every((n) => n.file === 'src')).toBe(true)
    // Mesmo diretório -> arestas internas descartadas (sem self-loop sintético).
    expect(g!.edges.every((e) => e.source !== e.target)).toBe(true)

    expect(g!.promptFormatted).toBeDefined()
    expect(g!.promptFormatted).toContain('src (2)') // '2' pois no agregação 'src' terá 2 símbolos (usar, somar)
  })

  it('devolve null para diretório sem código-fonte (nunca lança)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cgc-graph-empty-'))
    try {
      await expect(exportGraph(empty)).resolves.toBeNull()
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('constrói grafo cross-repo com nós File e arestas CALLS_CONTRACT e CROSS_REPO_DEPENDS_ON', async () => {
    const multiDir = mkdtempSync(join(tmpdir(), 'cgc-graph-multi-'))
    mkdirSync(join(multiDir, 'repoA/src'), { recursive: true })
    mkdirSync(join(multiDir, 'repoB/src'), { recursive: true })

    writeFileSync(join(multiDir, 'repoA/src/backend.ts'), 'export function handle() {}')
    writeFileSync(join(multiDir, 'repoA/src/schema.prisma'), 'model User {}')
    writeFileSync(join(multiDir, 'repoB/src/frontend.tsx'), 'function Button() {}')

    try {
      const summaryA = {
        sources: [],
        fileCount: 2,
        byType: [],
        topFiles: [],
        mostCalled: [],
        orphanModules: [],
        crossPackageDependencies: [],
        sharedRoutes: [],
        sharedModels: [
          { model: 'User', dbFile: 'src/schema.prisma', backendFile: 'src/backend.ts' },
        ],
      }

      const summaryB = {
        sources: [],
        fileCount: 1,
        byType: [],
        topFiles: [],
        mostCalled: [],
        orphanModules: [],
        crossPackageDependencies: [
          { source: 'src/frontend.tsx', target: '../repoA/src/backend.ts' },
        ],
        sharedRoutes: [
          {
            method: 'GET',
            path: '/api',
            backendFile: '../repoA/src/backend.ts',
            frontendFile: 'src/frontend.tsx',
          },
        ],
        sharedModels: [],
      }

      const repos = [
        { repositoryId: 'repoA', workspacePath: join(multiDir, 'repoA'), summary: summaryA },
        { repositoryId: 'repoB', workspacePath: join(multiDir, 'repoB'), summary: summaryB },
      ]

      const g = await exportGraph(repos)

      expect(g).not.toBeNull()
      // Deve existir nó para o arquivo backend, schema e frontend criados pelos relacionamentos cross-repo.
      const nodes = g!.nodes
      const backendFileNode = nodes.find(
        (n) => n.type === 'file' && n.file === 'src/backend.ts' && n.repositoryId === 'repoA'
      )
      const dbFileNode = nodes.find(
        (n) => n.type === 'file' && n.file === 'src/schema.prisma' && n.repositoryId === 'repoA'
      )
      const frontendFileNode = nodes.find(
        (n) => n.type === 'file' && n.file === 'src/frontend.tsx' && n.repositoryId === 'repoB'
      )

      expect(backendFileNode).toBeDefined()
      expect(dbFileNode).toBeDefined()
      expect(frontendFileNode).toBeDefined()

      // Validação das arestas cross-repo
      const edges = g!.edges

      // CALLS_CONTRACT do frontend para o backend
      const callsContract = edges.find(
        (e) =>
          e.rel === 'CALLS_CONTRACT' &&
          e.source === frontendFileNode!.id &&
          e.target === backendFileNode!.id
      )
      expect(callsContract).toBeDefined()

      // CROSS_REPO_DEPENDS_ON do backend para o banco de dados
      const dependsOnDb = edges.find(
        (e) =>
          e.rel === 'CROSS_REPO_DEPENDS_ON' &&
          e.source === backendFileNode!.id &&
          e.target === dbFileNode!.id
      )
      expect(dependsOnDb).toBeDefined()
    } finally {
      rmSync(multiDir, { recursive: true, force: true })
    }
  })
})
