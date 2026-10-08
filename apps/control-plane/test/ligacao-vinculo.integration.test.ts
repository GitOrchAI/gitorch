import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'
import { varrerRetratoDoProjeto } from '../src/services/varredura-do-retrato.js'
import { montarVinculoDoRetrato } from '../src/services/vinculo-no-retrato.js'
import { atualizarFichaDoItem, type PrismaDaFichaDoItem } from '../src/services/ficha-do-item.js'
import { ErroDoGitHub } from '../src/services/erro-do-github.js'
import {
  limparFreiosDeCota,
  registrarFreioDeCota,
} from '../src/services/freio-de-cota-do-github.js'

// O mock global de `@prisma/client` (src/test/setup.ts) não vale aqui: o vínculo
// só prova alguma coisa contra um Postgres de verdade.
vi.unmock('@prisma/client')

/**
 * A ligação PR → tarefa na varredura do retrato, contra o banco real e um
 * GitHub de mentira num servidor HTTP local. O que está em jogo:
 *
 *  - a ficha do PR (`repo_items`) ganha `issue_number` e `vinculo_origem`;
 *  - a linha de sessão do dev assíncrono responde SEM consulta ao GitHub;
 *  - o vínculo formal só vincula (a origem da ficha não muda);
 *  - o teto de PRs por ciclo, o cache de "sem vínculo" e o freio de cota
 *    seguram a conta de chamadas.
 *
 * Os números dos PRs e das tarefas são os de uma conferência real.
 */
const controlPlaneDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(controlPlaneDir, 'scripts', 'db-migrate.sh')
const adminUrl = process.env['GITORCH_TEST_DATABASE_URL']

function canConnect(url: string): boolean {
  try {
    execFileSync('psql', [url, '-tAc', 'SELECT 1'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const reachable = Boolean(adminUrl) && canConnect(adminUrl as string)

if (Boolean(process.env['CI']) && !reachable) {
  throw new Error('GITORCH_TEST_DATABASE_URL inalcançável em CI')
}

function requireAdminUrl(): string {
  if (!adminUrl) throw new Error('GITORCH_TEST_DATABASE_URL ausente')
  return adminUrl
}

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${dbName}`
  return parsed.toString()
}

function psql(url: string, sql: string): string {
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-qtA', '-c', sql], {
    encoding: 'utf-8',
  }).trim()
}

function applySchema(dbUrl: string): void {
  const result = spawnSync('bash', [scriptPath], {
    cwd: controlPlaneDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    encoding: 'utf-8',
  })
  if (result.status !== 0) {
    throw new Error(`scripts/db-migrate.sh falhou:\n${result.stdout}\n${result.stderr}`)
  }
}

const REPO = 'o/r'

interface PrDoServidor {
  number: number
  body?: string
  user: { login: string }
  head: { ref: string; sha: string }
  state: string
  draft: boolean
}

function pr(numero: number, extra: Partial<PrDoServidor> = {}): PrDoServidor {
  return {
    number: numero,
    state: 'open',
    draft: false,
    user: { login: 'autor-humano' },
    head: { ref: `ramo-${numero}`, sha: `sha${numero}` },
    body: '',
    ...extra,
  }
}

/** O GitHub de mentira: lista PRs e issues abertos e responde o GraphQL de "fecha a issue". */
function githubLocal(config: { prs: PrDoServidor[]; fechaA: Record<number, number[]> }) {
  const requisicoes: string[] = []
  const graphqlDosPrs: number[] = []
  const servidor: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    // O tipo de `@fastify/busboy` redeclara `Readable.on` só para o evento 'limit';
    // lido como EventEmitter, o fluxo volta a aceitar 'data' e 'end'.
    const corpoDaRequisicao: NodeJS.EventEmitter = req
    corpoDaRequisicao.on('data', (c: Buffer) => chunks.push(c))
    corpoDaRequisicao.on('end', () => {
      const caminho = req.url ?? ''
      requisicoes.push(`${req.method} ${caminho}`)
      const json = (corpo: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(corpo))
      }
      if (req.method === 'POST' && caminho === '/graphql') {
        const corpo = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          variables: { prNumber: number }
        }
        graphqlDosPrs.push(corpo.variables.prNumber)
        const nodes = (config.fechaA[corpo.variables.prNumber] ?? []).map((number) => ({ number }))
        return json({
          data: { repository: { pullRequest: { closingIssuesReferences: { nodes } } } },
        })
      }
      if (caminho.startsWith(`/repos/${REPO}/pulls?state=open`)) return json(config.prs)
      if (caminho.startsWith(`/repos/${REPO}/issues?state=open`)) {
        return json([
          { number: 3842, state: 'open', labels: [{ name: 'jules' }, { name: 'gitorch:task' }] },
          { number: 4036, state: 'open', labels: [{ name: 'bug' }] },
        ])
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  return { servidor, requisicoes, graphqlDosPrs }
}

type ProjetoPronto = { projectId: string }

describe.skipIf(!reachable)('vínculo da tarefa na varredura do retrato (integration)', () => {
  const dbName = `gitorch_it_ligacao_vinculo_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  let dbUrl = ''
  let prisma: PrismaClient
  let servidor: Server | null = null

  beforeAll(async () => {
    psql(requireAdminUrl(), `CREATE DATABASE "${dbName}"`)
    dbUrl = withDatabase(requireAdminUrl(), dbName)
    applySchema(dbUrl)
    const { PrismaClient: PrismaDeVerdade } = await import('@prisma/client')
    prisma = new PrismaDeVerdade({ datasources: { db: { url: dbUrl } } })
  }, 120_000)

  beforeEach(() => limparFreiosDeCota())

  afterEach(async () => {
    limparFreiosDeCota()
    if (servidor) await new Promise<void>((resolve) => servidor!.close(() => resolve()))
    servidor = null
  })

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    try {
      psql(requireAdminUrl(), `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    } catch {}
  })

  function novoProjeto(): ProjetoPronto {
    const projectId = randomUUID()
    psql(
      dbUrl,
      `INSERT INTO projects (id, wing_id, name, updated_at) ` +
        `VALUES ('${projectId}', '${REPO}-${projectId}', 'repo', now())`
    )
    return { projectId }
  }

  async function semearFicha(projectId: string, numero: number, origem: string | null) {
    await prisma.repoItem.create({
      data: { projectId, tipo: 'pr', numero, estado: { status: 'open' }, origem },
    })
  }

  async function semearSessao(projectId: string, issueNumber: number, pullRequestNumber: number) {
    await prisma.devSession.create({
      data: {
        projectId,
        issueNumber,
        sessionName: `sessions/${randomUUID()}`,
        pullRequestNumber,
        state: 'COMPLETED',
      },
    })
  }

  async function ficha(projectId: string, numero: number) {
    const linha = await prisma.repoItem.findUniqueOrThrow({
      where: { projectId_tipo_numero: { projectId, tipo: 'pr', numero } },
    })
    return {
      issue: linha.issueNumber,
      vinculoOrigem: linha.vinculoOrigem,
      origem: linha.origem,
      estado: linha.estado,
    }
  }

  async function iniciar(config: Parameters<typeof githubLocal>[0]) {
    const github = githubLocal(config)
    servidor = github.servidor
    await new Promise<void>((resolve) => servidor!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`
    const fetchLocal: typeof fetch = (input, init) =>
      fetch(String(input).replace('https://api.github.com', base), init)
    return { github, fetchLocal }
  }

  /** Uma passada da varredura, montada como o scheduler a monta. */
  function varrer(args: {
    projectId: string
    fetchLocal: typeof fetch
    cacheNegativo: Map<string, number>
    avisos?: string[]
  }) {
    return varrerRetratoDoProjeto({
      repo: REPO,
      ghGet: async (caminho) => {
        const resposta = await args.fetchLocal(`https://api.github.com${caminho}`)
        if (!resposta.ok) throw new Error(`${caminho} (${resposta.status})`)
        return resposta.json()
      },
      atualizarFicha: async (item) => {
        await atualizarFichaDoItem({
          prisma: prisma as unknown as PrismaDaFichaDoItem,
          projectId: args.projectId,
          tipo: item.tipo,
          numero: item.numero,
          estado: item.estado,
        })
      },
      onWarn: (m) => args.avisos?.push(m),
      vincularTarefa: montarVinculoDoRetrato({
        prisma,
        projectId: args.projectId,
        repo: REPO,
        githubToken: 'token-de-teste',
        cacheNegativo: args.cacheNegativo,
        fetchImpl: args.fetchLocal,
        onWarn: (m) => args.avisos?.push(m),
      }),
    })
  }

  it('liga o PR da sessão (sem GraphQL) e o PR formal (1 GraphQL); o resto fica como estava', async () => {
    const { projectId } = novoProjeto()
    // 4072: linha de sessão guardada, ficha como "pessoa". 4037: "Fixes #4036".
    // 4099: sem pista nenhuma. 4100: do Dependabot.
    await semearFicha(projectId, 4072, 'pessoa')
    await semearFicha(projectId, 4037, 'pessoa')
    await semearFicha(projectId, 4099, null)
    await semearFicha(projectId, 4100, 'dependabot')
    await semearSessao(projectId, 3842, 4072)
    const { github, fetchLocal } = await iniciar({
      prs: [pr(4072), pr(4037, { body: 'Fixes #4036' }), pr(4099), pr(4100)],
      fechaA: { 4037: [4036] },
    })

    await varrer({ projectId, fetchLocal, cacheNegativo: new Map() })

    expect(await ficha(projectId, 4072)).toMatchObject({
      issue: 3842,
      vinculoOrigem: 'texto',
      origem: 'jules_gitorch',
      estado: expect.objectContaining({ status: 'open' }),
    })
    expect(await ficha(projectId, 4037)).toMatchObject({
      issue: 4036,
      vinculoOrigem: 'formal',
      origem: 'pessoa',
    })
    expect(await ficha(projectId, 4099)).toMatchObject({ issue: null, vinculoOrigem: null })
    expect(await ficha(projectId, 4100)).toMatchObject({ issue: null, origem: 'dependabot' })

    // Orçamento do ciclo: o PR da sessão e o do bot não foram ao GitHub.
    expect(github.graphqlDosPrs.sort()).toEqual([4037, 4099])

    // O rastro no painel: um registro por vínculo.
    const chaves = psql(
      dbUrl,
      `SELECT payload->>'chave' FROM events WHERE project_id = '${projectId}' AND type = 'audit' ORDER BY 1`
    ).split('\n')
    expect(chaves).toEqual([
      `vinculo-da-tarefa:${REPO}:4037:4036`,
      `vinculo-da-tarefa:${REPO}:4072:3842`,
    ])
  })

  it('segundo ciclo: nada é reconsultado (vínculo gravado e cache de "sem vínculo"), e o painel não duplica', async () => {
    const { projectId } = novoProjeto()
    await semearFicha(projectId, 4072, 'pessoa')
    await semearFicha(projectId, 4037, 'pessoa')
    await semearFicha(projectId, 4099, null)
    await semearSessao(projectId, 3842, 4072)
    const { github, fetchLocal } = await iniciar({
      prs: [pr(4072), pr(4037, { body: 'Fixes #4036' }), pr(4099)],
      fechaA: { 4037: [4036] },
    })
    const cacheNegativo = new Map<string, number>()

    await varrer({ projectId, fetchLocal, cacheNegativo })
    const noPrimeiro = github.graphqlDosPrs.length
    await varrer({ projectId, fetchLocal, cacheNegativo })

    expect(noPrimeiro).toBe(2)
    expect(github.graphqlDosPrs).toHaveLength(2)
    const registros = psql(
      dbUrl,
      `SELECT count(*) FROM events WHERE project_id = '${projectId}' AND type = 'audit'`
    )
    expect(registros).toBe('2')
  })

  it('teto: no máximo 5 PRs sem pista são consultados por ciclo; o resto espera o próximo', async () => {
    const { projectId } = novoProjeto()
    const numeros = [201, 202, 203, 204, 205, 206, 207, 208]
    for (const n of numeros) await semearFicha(projectId, n, 'pessoa')
    const { github, fetchLocal } = await iniciar({ prs: numeros.map((n) => pr(n)), fechaA: {} })
    const cacheNegativo = new Map<string, number>()

    await varrer({ projectId, fetchLocal, cacheNegativo })
    expect(github.graphqlDosPrs).toHaveLength(5)

    await varrer({ projectId, fetchLocal, cacheNegativo })
    // Os 5 de antes estão em quarentena; só os 3 que faltavam são consultados.
    expect(github.graphqlDosPrs).toHaveLength(8)
    expect(new Set(github.graphqlDosPrs).size).toBe(8)
  })

  it('freio de cota ativo: nenhuma consulta formal sai, a linha de sessão ainda liga, e nada vira "sem vínculo"', async () => {
    const { projectId } = novoProjeto()
    await semearFicha(projectId, 4072, 'pessoa')
    await semearFicha(projectId, 4099, null)
    await semearSessao(projectId, 3842, 4072)
    const { github, fetchLocal } = await iniciar({ prs: [pr(4072), pr(4099)], fechaA: {} })
    registrarFreioDeCota(
      'o',
      new ErroDoGitHub('limite', {
        status: 429,
        retryAfterSegundos: 600,
        limiteRestante: 0,
        limiteResetaEmSegundos: null,
      }),
      new Date()
    )
    const cacheNegativo = new Map<string, number>()

    await varrer({ projectId, fetchLocal, cacheNegativo })

    expect(github.graphqlDosPrs).toEqual([])
    expect(await ficha(projectId, 4072)).toMatchObject({ issue: 3842 })
    expect(await ficha(projectId, 4099)).toMatchObject({ issue: null })
    expect(cacheNegativo.size).toBe(0)
  })
})
