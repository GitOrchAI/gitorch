import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'
import { CortexClient } from '@gitorch/cortex'
import { runQaMissionViaRails } from '../src/services/qa-rails-mission.js'
import { montarOpcoesDoJulgamento } from '../src/plugins/scheduler.js'
import {
  buildMissionEnricher,
  PREFIXO_DA_GAVETA_DE_DIRECAO,
  PREFIXO_DA_GAVETA_DE_ENTENDIMENTO,
  persistMissionMemory,
  SALA_DA_DIRECAO,
  SALA_DO_ENTENDIMENTO,
} from '../src/services/mission-context.js'
import type { LinhaDeSessao } from '../src/services/dev-session-store.js'

// O mock global de `@prisma/client` (src/test/setup.ts) não vale aqui.
vi.unmock('@prisma/client')

/**
 * O entendimento do pedido registrado pelo caminho REAL do julgamento do QA:
 * as opções que o scheduler monta (`montarOpcoesDoJulgamento`), o banco de
 * verdade, um Cortex em arquivo SQLite temporário e um GitHub em memória.
 *
 * O que está em jogo:
 *  - a ficha do PR ganha o `entendimento` e MANTÉM o retrato (`estado`);
 *  - a gaveta do Cortex vai para a sala própria, e o PO continua recebendo
 *    exatamente o que recebia antes (nenhuma lacuna falsa);
 *  - registrar o entendimento NÃO muda o que o juiz lê: o grafo de vínculos
 *    continua fora do prompt, porque `prisma`/`projectId` não entram como
 *    opções de topo do julgamento.
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

const REPOSITORIO = 'o/r'
const NUMERO_DO_PR = 42
const NUMERO_DA_ISSUE = 50

const COMENTARIO = {
  titulo: 'Reviews API',
  goal: 'Rework necessário.',
  taskDetails: 'Sem checagem de material no controller.',
  taskDescription: 'O PR entrega os endpoints.',
  implementationGuide: '1. validar o corpo; 2. teste do caso inválido',
  verificationCriteria: '- a rota responde 400 para corpo inválido',
  dependencies: 'nenhuma',
  relatedFiles: 'src/reviews.ts',
  notes: 'CI verde.',
}
const ENTENDIMENTO = {
  deOndeVeio: 'Jules solicitou via PR',
  oQueMuda: 'Adiciona endpoints de review com regras',
  queAjusteE: 'feature importante',
  porQueExiste: 'para o app ler as reviews reais',
}
const REPROVA = JSON.stringify({
  verdict: 'request_changes',
  comment: COMENTARIO,
  entendimento: ENTENDIMENTO,
})

function githubEmMemoria(head: string) {
  const reviews: unknown[] = []
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
  const fetchImpl = (async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    const caminho = String(url).replace('https://api.github.com', '').split('?')[0]!
    const metodo = init?.method ?? 'GET'
    const base = `/repos/${REPOSITORIO}`
    if (caminho === `${base}/pulls`) {
      return json([
        {
          number: NUMERO_DO_PR,
          user: { login: 'jules[bot]' },
          draft: false,
          body: `Closes #${NUMERO_DA_ISSUE}`,
          head: { sha: head },
        },
      ])
    }
    if (caminho === `${base}/pulls/${NUMERO_DO_PR}`) {
      return json({
        number: NUMERO_DO_PR,
        body: `Closes #${NUMERO_DA_ISSUE}`,
        head: { sha: head },
        base: { ref: 'main' },
        changed_files: 1,
        additions: 3,
        deletions: 0,
      })
    }
    if (caminho === `${base}/pulls/${NUMERO_DO_PR}/reviews`) {
      if (metodo === 'GET') return json(reviews)
      reviews.push(init?.body ? JSON.parse(String(init.body)) : {})
      return json({ id: reviews.length })
    }
    if (caminho === `${base}/pulls/${NUMERO_DO_PR}/files`) {
      const pagina = Number(new URL(String(url)).searchParams.get('page') ?? '1')
      return json(pagina > 1 ? [] : [{ filename: 'src/a.ts', patch: '+codigo' }])
    }
    if (caminho === `${base}/issues/${NUMERO_DA_ISSUE}`) {
      return json({
        number: NUMERO_DA_ISSUE,
        labels: [{ name: 'jules' }, { name: 'gitorch:task' }],
        body: '## Verification Criteria\n\n- a rota responde',
      })
    }
    if (/\/commits\/[^/]+\/check-runs$/.test(caminho)) {
      return json({ check_runs: [{ name: 'ci', conclusion: 'success', status: 'completed' }] })
    }
    if (caminho.endsWith('/actions/runs')) return json({ workflow_runs: [] })
    if (caminho === base) return json({ default_branch: 'main' })
    return json({})
  }) as typeof fetch
  return { fetchImpl, reviews }
}

function linhaDaEntrega(projectId: string): LinhaDeSessao {
  return {
    id: 'x',
    projectId,
    issueNumber: NUMERO_DA_ISSUE,
    sessionName: 'sessions/x',
    state: 'COMPLETED',
    answeredHash: null,
    pullRequestNumber: NUMERO_DO_PR,
    attempts: 1,
    nudges: 0,
    lastProgressAt: null,
    stateCheckedAt: null,
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: null,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    deployFixKey: null,
    envLastVerdict: null,
    closedAt: null,
  }
}

type PrismaDoScheduler = Parameters<typeof montarOpcoesDoJulgamento>[0]['prisma']

describe.skipIf(!reachable)('entendimento do pedido registrado no julgamento (integration)', () => {
  const dbName = `gitorch_it_ligacao_entendimento_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  let dbUrl = ''
  let prisma: PrismaClient
  let pastaDoCortex = ''
  let cortex: CortexClient

  beforeAll(async () => {
    psql(requireAdminUrl(), `CREATE DATABASE "${dbName}"`)
    dbUrl = withDatabase(requireAdminUrl(), dbName)
    applySchema(dbUrl)
    const { PrismaClient: PrismaDeVerdade } = await import('@prisma/client')
    prisma = new PrismaDeVerdade({ datasources: { db: { url: dbUrl } } })
    pastaDoCortex = mkdtempSync(join(tmpdir(), 'gitorch-it-entendimento-'))
    cortex = new CortexClient({ sqlitePath: join(pastaDoCortex, 'cortex.sqlite') })
    cortex.init()
  }, 120_000)

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    cortex?.close()
    if (pastaDoCortex) rmSync(pastaDoCortex, { recursive: true, force: true })
    try {
      psql(requireAdminUrl(), `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    } catch {}
  })

  function novoProjeto(): string {
    const projectId = randomUUID()
    psql(
      dbUrl,
      `INSERT INTO projects (id, wing_id, name, updated_at) ` +
        `VALUES ('${projectId}', '${REPOSITORIO}-${projectId}', 'repo', now())`
    )
    return projectId
  }

  /** Exatamente o que o scheduler espalha em `runQaMissionViaRails`. */
  function opcoesDeProducao(projectId: string) {
    return montarOpcoesDoJulgamento({
      prisma: prisma as unknown as PrismaDoScheduler,
      cortex,
      projectId,
      runtimeConfig: null,
      avisarDono: async () => true,
    })
  }

  async function fichaDoPr(projectId: string) {
    return prisma.repoItem.findUniqueOrThrow({
      where: { projectId_tipo_numero: { projectId, tipo: 'pr', numero: NUMERO_DO_PR } },
    })
  }

  it('julgamento com entendimento: ficha do PR com `estado` preservado, gaveta na sala própria, PO sem lacuna nova, prompt sem o grafo', async () => {
    const projectId = novoProjeto()
    const estadoAntes = {
      status: 'open',
      rascunho: false,
      conflito: false,
      verificacao: 'success',
      arquivosMexidos: ['src/a.ts'],
    }
    await prisma.repoItem.create({
      data: {
        projectId,
        tipo: 'pr',
        numero: NUMERO_DO_PR,
        estado: estadoAntes,
        origem: 'jules_gitorch',
      },
    })
    // Um grafo de vínculos JÁ coletado: se o julgamento ligasse o bloco do
    // grafo (opções `prisma`/`projectId` de topo), ele apareceria no prompt.
    const ficha = await fichaDoPr(projectId)
    await prisma.repoItemVinculos.create({
      data: {
        repoItemId: ficha.id,
        hierarquia: { pai: { numero: 7, titulo: 'Épico das reviews' } },
      },
    })

    // A memória do projeto antes do julgamento: o contrato do RA e uma lacuna do QA.
    const agora = '2026-10-07T10:00:00.000Z'
    await persistMissionMemory(cortex, {
      projectId,
      role: 'ra',
      content: '### Journey 0: comprador\n1. abre a loja',
      now: agora,
    })
    await persistMissionMemory(cortex, {
      projectId,
      role: 'qa',
      content: 'QA gap: o repositório não tem verificação automática',
      now: agora,
    })
    const antes = await buildMissionEnricher({ cortex })({ projectId, role: 'po' })
    expect(antes.length).toBeGreaterThan(0)

    const github = githubEmMemoria('aaa111')
    const execute = vi.fn(async (_prompt: string) => REPROVA)
    const opcoes = opcoesDeProducao(projectId)
    // A restrição crítica: o grafo de vínculos do prompt NÃO é ligado.
    expect(Object.keys(opcoes)).not.toContain('prisma')
    expect(Object.keys(opcoes)).not.toContain('projectId')

    await runQaMissionViaRails({
      repository: REPOSITORIO,
      githubToken: 't',
      fetchImpl: github.fetchImpl,
      sessoes: [linhaDaEntrega(projectId)],
      avisarSessao: async () => true,
      ...opcoes,
      execute,
    })

    expect(github.reviews).toHaveLength(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]![0]).not.toContain('Grafo de vínculos')
    expect(execute.mock.calls[0]![0]).not.toContain('Épico das reviews')

    // A ficha: entendimento gravado, retrato intacto.
    const depois = await fichaDoPr(projectId)
    expect(depois.entendimento).toEqual(ENTENDIMENTO)
    expect(depois.estado).toEqual(estadoAntes)

    // A gaveta: uma, na sala própria, no projeto certo, nenhuma na sala `qa`.
    const gavetas = cortex.recallLocal(projectId, SALA_DO_ENTENDIMENTO)
    expect(gavetas).toHaveLength(1)
    expect(gavetas[0]!.content.startsWith(PREFIXO_DA_GAVETA_DE_ENTENDIMENTO)).toBe(true)
    expect(gavetas[0]!.content).toContain('commit aaa111')
    expect(
      cortex
        .recallLocal(projectId, 'qa')
        .filter((g) => g.content.includes('Entendimento do pull request'))
    ).toEqual([])

    // O PO recebe exatamente o que recebia antes.
    const aposOJulgamento = await buildMissionEnricher({ cortex })({ projectId, role: 'po' })
    expect(aposOJulgamento).toEqual(antes)
    expect(aposOJulgamento.join('\n')).not.toContain('Entendimento do pull request')
  })

  it('registrar de novo o mesmo entendimento no mesmo commit não regrava ficha nem gaveta', async () => {
    const projectId = novoProjeto()
    await prisma.repoItem.create({
      data: { projectId, tipo: 'pr', numero: NUMERO_DO_PR, estado: { status: 'open' } },
    })
    const opcoes = opcoesDeProducao(projectId)
    const args = { numeroDoPr: NUMERO_DO_PR, headSha: 'ccc333', entendimento: ENTENDIMENTO }

    await opcoes.registrarEntendimento(args)
    const primeira = await fichaDoPr(projectId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await opcoes.registrarEntendimento(args)
    const segunda = await fichaDoPr(projectId)

    expect(segunda.atualizadoEm.getTime()).toBe(primeira.atualizadoEm.getTime())
    expect(cortex.recallLocal(projectId, SALA_DO_ENTENDIMENTO)).toHaveLength(1)

    // Commit novo, mesmo entendimento: gaveta nova, ficha intacta.
    await opcoes.registrarEntendimento({ ...args, headSha: 'ddd444' })
    expect(cortex.recallLocal(projectId, SALA_DO_ENTENDIMENTO)).toHaveLength(2)
    expect((await fichaDoPr(projectId)).atualizadoEm.getTime()).toBe(
      primeira.atualizadoEm.getTime()
    )
  })

  it('PR de origem `assistente`: julgar grava UMA direção; o PO continua começando pelo contrato; o prompt do juiz não muda', async () => {
    const projectId = novoProjeto()
    await prisma.repoItem.create({
      data: {
        projectId,
        tipo: 'pr',
        numero: NUMERO_DO_PR,
        estado: { status: 'open' },
        origem: 'assistente',
      },
    })
    const contrato = '### Journey 0: comprador\n1. abre a loja'
    await persistMissionMemory(cortex, {
      projectId,
      role: 'ra',
      content: contrato,
      now: '2026-10-07T10:00:00.000Z',
    })

    const github = githubEmMemoria('eee555')
    const execute = vi.fn(async (_prompt: string) => REPROVA)
    await runQaMissionViaRails({
      repository: REPOSITORIO,
      githubToken: 't',
      fetchImpl: github.fetchImpl,
      sessoes: [linhaDaEntrega(projectId)],
      avisarSessao: async () => true,
      ...opcoesDeProducao(projectId),
      execute,
    })

    const gavetas = cortex.recallLocal(projectId, SALA_DA_DIRECAO)
    expect(gavetas).toHaveLength(1)
    expect(gavetas[0]!.content.startsWith(PREFIXO_DA_GAVETA_DE_DIRECAO)).toBe(true)
    expect(gavetas[0]!.content).toContain('origem: assistente')
    expect(execute.mock.calls[0]![0]).not.toContain(PREFIXO_DA_GAVETA_DE_DIRECAO)

    const po = await buildMissionEnricher({ cortex })({ projectId, role: 'po' })
    expect(po[0]).toBe(contrato)
    expect(po.join('\n')).toContain(PREFIXO_DA_GAVETA_DE_DIRECAO)
    const ra = await buildMissionEnricher({ cortex })({ projectId, role: 'ra' })
    expect(ra.join('\n')).toContain(PREFIXO_DA_GAVETA_DE_DIRECAO)

    // Rejulgar (outro commit) atualiza a mesma gaveta.
    await opcoesDeProducao(projectId).registrarDirecao({
      numeroDoPr: NUMERO_DO_PR,
      headSha: 'fff666',
      entendimento: ENTENDIMENTO,
    })
    expect(cortex.recallLocal(projectId, SALA_DA_DIRECAO)).toHaveLength(1)
  })

  it('PR do Jules pelo GitOrch: julgar não grava direção nenhuma', async () => {
    const projectId = novoProjeto()
    await prisma.repoItem.create({
      data: {
        projectId,
        tipo: 'pr',
        numero: NUMERO_DO_PR,
        estado: { status: 'open' },
        origem: 'jules_gitorch',
      },
    })

    await runQaMissionViaRails({
      repository: REPOSITORIO,
      githubToken: 't',
      fetchImpl: githubEmMemoria('ggg777').fetchImpl,
      sessoes: [linhaDaEntrega(projectId)],
      avisarSessao: async () => true,
      ...opcoesDeProducao(projectId),
      execute: async () => REPROVA,
    })

    expect(cortex.recallLocal(projectId, SALA_DA_DIRECAO)).toEqual([])
  })
})
