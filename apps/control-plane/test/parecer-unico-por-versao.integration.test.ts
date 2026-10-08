import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PrismaClient } from '@prisma/client'
import { runQaMissionViaRails } from '../src/services/qa-rails-mission.js'
import { adquirirTravaDeParecer } from '../src/services/trava-de-parecer.js'
import { montarOpcoesDoJulgamento } from '../src/plugins/scheduler.js'
import type { LinhaDeSessao } from '../src/services/dev-session-store.js'

// O mock global de `@prisma/client` (src/test/setup.ts) não vale aqui: a trava
// só prova alguma coisa contra um Postgres de verdade.
vi.unmock('@prisma/client')

/**
 * Um parecer por versão do pedido, contra o caminho REAL da produção.
 *
 * Duas missões do QA do MESMO projeto chegam a rodar juntas (o único freio de
 * concorrência do scheduler é global), e cada uma fazia o julgamento inteiro —
 * dois pareceres no mesmo commit, dois avisos ao dev, duas tentativas de
 * mescla. A trava de parecer existia, mas nunca era ligada: o scheduler monta
 * as opções do julgamento com `montarOpcoesDoJulgamento` e esta não devolvia a
 * trava. Por isso o teste usa EXATAMENTE essa função, o banco real e um GitHub
 * em memória COMPARTILHADO entre as duas missões; não há mock da trava.
 *
 * A ficha do PR (`repo_items`) NÃO é criada antes: a corrida pela criação dela
 * faz parte do que está sendo provado.
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

const isCI = Boolean(process.env['CI'])
if (isCI && !reachable) {
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

const dormir = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const REPOSITORIO = 'o/r'
const NUMERO_DO_PR = 42
const NUMERO_DA_ISSUE = 50

const COMENTARIO = {
  titulo: 'Reviews API',
  goal: 'Todos os critérios atendidos.',
  taskDetails: 'Diff cobre schema, rota e teste.',
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
const APROVA = JSON.stringify({
  verdict: 'approve',
  comment: COMENTARIO,
  entendimento: ENTENDIMENTO,
})
const REPROVA = JSON.stringify({
  verdict: 'request_changes',
  comment: COMENTARIO,
  entendimento: ENTENDIMENTO,
})

interface ReviewPublicada {
  id: number
  body: string
  /** O commit que valia no GitHub quando a review foi postada. */
  commit_id: string
  event: string
}

/**
 * O GitHub de uma entrega só, ÚNICO para as duas missões: o que uma publica, a
 * outra enxerga (e conta). `head` muda para simular um commit novo.
 */
function githubEmMemoria(inicial: {
  head: string
  falharNoComentario?: boolean
  /** O PR existe, mas nenhum commit chegou na branch dele (diff vazio). */
  semConteudo?: boolean
}) {
  const estado = {
    head: inicial.head,
    reviews: [] as ReviewPublicada[],
    comentarios: [] as unknown[],
    merges: [] as unknown[],
  }
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })
  const fetchImpl = (async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    const caminho = String(url).replace('https://api.github.com', '').split('?')[0]!
    const metodo = init?.method ?? 'GET'
    const corpo = init?.body ? JSON.parse(String(init.body)) : {}
    const base = `/repos/${REPOSITORIO}`

    if (caminho === `${base}/pulls`) {
      return json([
        {
          number: NUMERO_DO_PR,
          user: { login: 'jules[bot]' },
          draft: false,
          body: `Closes #${NUMERO_DA_ISSUE}`,
          head: { sha: estado.head },
        },
      ])
    }
    if (caminho === `${base}/pulls/${NUMERO_DO_PR}`) {
      return json({
        number: NUMERO_DO_PR,
        body: `Closes #${NUMERO_DA_ISSUE}`,
        head: { sha: estado.head },
        base: { ref: 'main' },
        changed_files: inicial.semConteudo ? 0 : 1,
        additions: inicial.semConteudo ? 0 : 3,
        deletions: 0,
      })
    }
    if (caminho === `${base}/pulls/${NUMERO_DO_PR}/reviews`) {
      if (metodo === 'GET') return json(estado.reviews)
      estado.reviews.push({
        id: estado.reviews.length + 1,
        body: corpo.body,
        commit_id: estado.head,
        event: corpo.event,
      })
      return json({ id: estado.reviews.length })
    }
    if (caminho === `${base}/pulls/${NUMERO_DO_PR}/files`) {
      const pagina = Number(new URL(String(url)).searchParams.get('page') ?? '1')
      return json(pagina > 1 ? [] : [{ filename: 'src/a.ts', patch: '+codigo' }])
    }
    if (caminho === `${base}/pulls/${NUMERO_DO_PR}/merge`) {
      estado.merges.push(corpo)
      return json({ merged: true, sha: 'deadbeef' })
    }
    if (caminho === `${base}/issues/${NUMERO_DA_ISSUE}`) {
      return json({
        number: NUMERO_DA_ISSUE,
        labels: [{ name: 'jules' }, { name: 'gitorch:task' }],
        body: '## Verification Criteria\n\n- a rota responde',
      })
    }
    if (caminho === `${base}/issues/${NUMERO_DO_PR}/comments` && metodo === 'POST') {
      if (inicial.falharNoComentario) {
        return new Response(JSON.stringify({ message: 'erro' }), { status: 500 })
      }
      estado.comentarios.push(corpo)
      return json({ id: 1 })
    }
    if (/\/commits\/[^/]+\/check-runs$/.test(caminho)) {
      return json({ check_runs: [{ name: 'ci', conclusion: 'success', status: 'completed' }] })
    }
    if (caminho.endsWith('/actions/runs')) return json({ workflow_runs: [] })
    if (caminho === base) return json({ default_branch: 'main' })
    return json({})
  }) as typeof fetch
  return { fetchImpl, estado }
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

describe.skipIf(!reachable)('um parecer por versão do pedido (integration)', () => {
  const dbName = `gitorch_it_parecer_unico_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  let dbUrl = ''
  let prisma: PrismaClient

  beforeAll(async () => {
    psql(requireAdminUrl(), `CREATE DATABASE "${dbName}"`)
    dbUrl = withDatabase(requireAdminUrl(), dbName)
    applySchema(dbUrl)
    const { PrismaClient: PrismaDeVerdade } = await import('@prisma/client')
    prisma = new PrismaDeVerdade({ datasources: { db: { url: dbUrl } } })
  }, 120_000)

  afterEach(() => {
    vi.useRealTimers()
  })

  afterAll(async () => {
    if (prisma) await prisma.$disconnect()
    try {
      psql(requireAdminUrl(), `DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    } catch {}
  })

  /** Um projeto novo por teste: a ficha do PR de um não aparece no outro. */
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
      // A memória do projeto não é o objeto deste teste: uma que não guarda nada.
      cortex: { recallLocal: () => [], writeDrawer: async () => undefined },
      projectId,
      // Sem configuração de projeto: o teste não depende da direção vinda do runtimeConfig.
      runtimeConfig: null,
      avisarDono: async () => true,
    })
  }

  function fichaDoPr(projectId: string) {
    const linha = psql(
      dbUrl,
      `SELECT coalesce(parecer_trava_head_sha, ''), (parecer_travado_ate IS NOT NULL)::text ` +
        `FROM repo_items WHERE project_id = '${projectId}' AND tipo = 'pr' AND numero = ${NUMERO_DO_PR}`
    )
    if (!linha) return null
    const [headSha, travada] = linha.split('|')
    return { headSha: headSha ?? '', travada: travada === 'true' }
  }

  /** Até quando a trava da ficha vale, em milissegundos de época (null = solta). */
  function validadeDaTrava(projectId: string): number | null {
    const valor = psql(
      dbUrl,
      `SELECT coalesce((extract(epoch from parecer_travado_ate) * 1000)::bigint::text, '') ` +
        `FROM repo_items WHERE project_id = '${projectId}' AND tipo = 'pr' AND numero = ${NUMERO_DO_PR}`
    )
    return valor === '' ? null : Number(valor)
  }

  /**
   * Só o RELÓGIO é simulado (`Date`); os temporizadores seguem reais, porque o
   * banco e o GitHub em memória dependem deles. A trava compara a validade com
   * o `new Date()` de quem a toma, então avançar o relógio é avançar o mundo.
   */
  function relogioSimuladoEm(inicio: Date) {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(inicio)
    return {
      avancar: (ms: number) => vi.setSystemTime(new Date(Date.now() + ms)),
    }
  }

  /** Espera de verdade (relógio real do teste) até a condição valer. */
  async function aguardar(condicao: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !condicao(); i++) await dormir(10)
    expect(condicao()).toBe(true)
  }

  function julgamentosGravados(projectId: string): number {
    return Number(
      psql(
        dbUrl,
        `SELECT count(*) FROM events WHERE project_id = '${projectId}' AND type = 'qa_judgment'`
      )
    )
  }

  it('corrida de APROVAÇÃO no mesmo commit: um parecer, um julgamento do motor, uma mescla', async () => {
    const projectId = novoProjeto()
    const github = githubEmMemoria({ head: 'aaa111' })
    const execute = vi.fn(async () => {
      await dormir(50)
      return APROVA
    })
    const opcoes = opcoesDeProducao(projectId)

    const resultados = await Promise.all(
      [1, 2].map(() =>
        runQaMissionViaRails({
          repository: REPOSITORIO,
          githubToken: 't',
          fetchImpl: github.fetchImpl,
          sessoes: [linhaDaEntrega(projectId)],
          ...opcoes,
          execute,
        })
      )
    )

    expect(github.estado.reviews).toHaveLength(1)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(github.estado.merges).toHaveLength(1)
    // A perdedora devolve uma acordada vazia, não um segundo julgamento.
    expect(resultados.filter((r) => r.noOp === true)).toHaveLength(1)
    expect(resultados.filter((r) => r.noOp !== true)).toHaveLength(1)
    expect(fichaDoPr(projectId)).toEqual({ headSha: 'aaa111', travada: true })
  })

  it('corrida de REPROVAÇÃO: um parecer, um aviso ao dev, um comentário de retrabalho, um julgamento na conta', async () => {
    const projectId = novoProjeto()
    const github = githubEmMemoria({ head: 'bbb222' })
    const execute = vi.fn(async () => {
      await dormir(50)
      return REPROVA
    })
    const avisarSessao = vi.fn(async () => true)
    const opcoes = opcoesDeProducao(projectId)

    await Promise.all(
      [1, 2].map(() =>
        runQaMissionViaRails({
          repository: REPOSITORIO,
          githubToken: 't',
          fetchImpl: github.fetchImpl,
          sessoes: [linhaDaEntrega(projectId)],
          avisarSessao,
          ...opcoes,
          execute,
        })
      )
    )

    expect(github.estado.reviews).toHaveLength(1)
    expect(github.estado.reviews[0]!.event).toBe('REQUEST_CHANGES')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(avisarSessao).toHaveBeenCalledTimes(1)
    expect(github.estado.comentarios).toHaveLength(1)
    // O histórico que alimenta "N barradas seguidas" não conta a mesma reprovação em dobro.
    expect(julgamentosGravados(projectId)).toBe(1)
    expect(fichaDoPr(projectId)).toEqual({ headSha: 'bbb222', travada: true })
  })

  it('corrida em entrega SEM conteúdo (diff vazio): uma cobrança só, um aviso ao dev, o motor nunca roda', async () => {
    const projectId = novoProjeto()
    const github = githubEmMemoria({ head: 'jjj000', semConteudo: true })
    const execute = vi.fn(async () => APROVA)
    const avisarSessao = vi.fn(async () => true)
    const opcoes = opcoesDeProducao(projectId)

    const resultados = await Promise.all(
      [1, 2].map(() =>
        runQaMissionViaRails({
          repository: REPOSITORIO,
          githubToken: 't',
          fetchImpl: github.fetchImpl,
          sessoes: [linhaDaEntrega(projectId)],
          avisarSessao,
          ...opcoes,
          execute,
        })
      )
    )

    expect(github.estado.reviews).toHaveLength(1)
    expect(github.estado.reviews[0]!.event).toBe('REQUEST_CHANGES')
    expect(avisarSessao).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
    expect(resultados.filter((r) => r.noOp === true)).toHaveLength(1)
    expect(fichaDoPr(projectId)).toEqual({ headSha: 'jjj000', travada: true })
  })

  it('erro ANTES de publicar libera a trava: a nova tentativa (ex.: outro motor) julga o commit', async () => {
    const projectId = novoProjeto()
    const github = githubEmMemoria({ head: 'ccc333' })
    const opcoes = opcoesDeProducao(projectId)
    const falha = new Error('motor fora do ar')

    await expect(
      runQaMissionViaRails({
        repository: REPOSITORIO,
        githubToken: 't',
        fetchImpl: github.fetchImpl,
        ...opcoes,
        execute: async () => {
          throw falha
        },
      })
    ).rejects.toBe(falha)

    expect(github.estado.reviews).toHaveLength(0)
    expect(fichaDoPr(projectId)).toEqual({ headSha: 'ccc333', travada: false })

    const segunda = await runQaMissionViaRails({
      repository: REPOSITORIO,
      githubToken: 't',
      fetchImpl: github.fetchImpl,
      ...opcoes,
      execute: async () => APROVA,
    })

    expect(segunda.noOp).toBeUndefined()
    expect(github.estado.reviews).toHaveLength(1)
  })

  it('erro DEPOIS de publicar NÃO libera a trava: o parecer já saiu', async () => {
    const projectId = novoProjeto()
    const github = githubEmMemoria({ head: 'ddd444', falharNoComentario: true })
    const opcoes = opcoesDeProducao(projectId)

    await expect(
      runQaMissionViaRails({
        repository: REPOSITORIO,
        githubToken: 't',
        fetchImpl: github.fetchImpl,
        sessoes: [linhaDaEntrega(projectId)],
        ...opcoes,
        execute: async () => REPROVA,
      })
    ).rejects.toThrow(/500/)

    expect(github.estado.reviews).toHaveLength(1)
    expect(fichaDoPr(projectId)).toEqual({ headSha: 'ddd444', travada: true })
  })

  it('commit novo no mesmo PR passa pela trava e recebe o próprio parecer', async () => {
    const projectId = novoProjeto()
    const github = githubEmMemoria({ head: 'eee555' })
    const opcoes = opcoesDeProducao(projectId)
    const rodar = () =>
      runQaMissionViaRails({
        repository: REPOSITORIO,
        githubToken: 't',
        fetchImpl: github.fetchImpl,
        ...opcoes,
        execute: async () => REPROVA,
      })

    await rodar()
    github.estado.head = 'fff666'
    const segunda = await rodar()

    expect(segunda.noOp).toBeUndefined()
    expect(github.estado.reviews.map((r) => r.commit_id)).toEqual(['eee555', 'fff666'])
    expect(fichaDoPr(projectId)).toEqual({ headSha: 'fff666', travada: true })
  })

  // O motor pode levar muito mais do que a folga de depois do parecer (o
  // Antigravity chega a 20 min). A trava é tomada ANTES do motor, então ela
  // precisa valer durante todo o julgamento, e não só por alguns minutos.
  describe('julgamento lento, validade da trava em duas janelas', () => {
    const INICIO = new Date('2026-03-01T12:00:00.000Z')
    const MIN = 60_000

    function missao(
      projectId: string,
      github: ReturnType<typeof githubEmMemoria>,
      execute: () => Promise<string>
    ) {
      return runQaMissionViaRails({
        repository: REPOSITORIO,
        githubToken: 't',
        fetchImpl: github.fetchImpl,
        ...opcoesDeProducao(projectId),
        execute,
      })
    }

    it('o motor leva 10 min: a segunda missão ainda perde a trava e a primeira publica sozinha', async () => {
      const relogio = relogioSimuladoEm(INICIO)
      const projectId = novoProjeto()
      const github = githubEmMemoria({ head: 'lll121' })
      let liberarMotor!: () => void
      const motorLento = new Promise<void>((resolver) => {
        liberarMotor = resolver
      })
      const executeDaPrimeira = vi.fn(async () => {
        await motorLento
        return APROVA
      })
      const executeDaSegunda = vi.fn(async () => APROVA)

      const primeira = missao(projectId, github, executeDaPrimeira)
      await aguardar(() => executeDaPrimeira.mock.calls.length > 0)

      // 10 minutos depois, com o motor da primeira ainda rodando.
      relogio.avancar(10 * MIN)
      const segunda = await missao(projectId, github, executeDaSegunda)

      expect(segunda.noOp).toBe(true)
      expect(executeDaSegunda).not.toHaveBeenCalled()
      expect(github.estado.reviews).toHaveLength(0)

      liberarMotor()
      const resultadoDaPrimeira = await primeira

      expect(resultadoDaPrimeira.noOp).toBeUndefined()
      expect(executeDaPrimeira).toHaveBeenCalledTimes(1)
      expect(github.estado.reviews).toHaveLength(1)
      expect(github.estado.merges).toHaveLength(1)
    })

    it('depois de publicar, a trava é ENCURTADA para a folga de 3 min a contar da publicação', async () => {
      const relogio = relogioSimuladoEm(INICIO)
      const projectId = novoProjeto()
      const github = githubEmMemoria({ head: 'mmm232' })

      await missao(projectId, github, async () => {
        relogio.avancar(10 * MIN)
        return APROVA
      })

      expect(github.estado.reviews).toHaveLength(1)
      const publicouEm = INICIO.getTime() + 10 * MIN
      expect(validadeDaTrava(projectId)).toBe(publicouEm + 3 * MIN)
    })

    it('a lista de reviews do GitHub atrasada não faz repetir o parecer dentro da folga, e depois dela o commit pode ser julgado de novo', async () => {
      const relogio = relogioSimuladoEm(INICIO)
      const projectId = novoProjeto()
      const github = githubEmMemoria({ head: 'nnn343' })

      await missao(projectId, github, async () => APROVA)
      expect(github.estado.reviews).toHaveLength(1)

      // A lista de reviews ainda não mostra o parecer que acabou de sair.
      github.estado.reviews.splice(0)
      relogio.avancar(2 * MIN)
      const dentroDaFolga = await missao(projectId, github, async () => APROVA)
      expect(dentroDaFolga.noOp).toBe(true)
      expect(github.estado.reviews).toHaveLength(0)

      // Passada a folga, o mesmo commit volta a poder ser julgado.
      relogio.avancar(1 * MIN + 1_000)
      const depoisDaFolga = await missao(projectId, github, async () => APROVA)
      expect(depoisDaFolga.noOp).toBeUndefined()
      expect(github.estado.reviews).toHaveLength(1)
    })

    it('erro depois de 10 min de motor, sem ter publicado, libera a trava e a nova tentativa julga', async () => {
      const relogio = relogioSimuladoEm(INICIO)
      const projectId = novoProjeto()
      const github = githubEmMemoria({ head: 'ooo454' })
      const falha = new Error('motor caiu no meio do julgamento')

      await expect(
        missao(projectId, github, async () => {
          relogio.avancar(10 * MIN)
          throw falha
        })
      ).rejects.toBe(falha)

      expect(validadeDaTrava(projectId)).toBeNull()
      const retentativa = await missao(projectId, github, async () => APROVA)
      expect(retentativa.noOp).toBeUndefined()
      expect(github.estado.reviews).toHaveLength(1)
    })
  })

  it('o gancho devolvido por montarOpcoesDoJulgamento dá [true, false] para duas chamadas concorrentes', async () => {
    const projectId = novoProjeto()
    const opcoes = opcoesDeProducao(projectId)

    const resultados = await Promise.all([
      opcoes.adquirirTrava({ numeroDoPr: NUMERO_DO_PR, headSha: 'ggg777' }),
      opcoes.adquirirTrava({ numeroDoPr: NUMERO_DO_PR, headSha: 'ggg777' }),
    ])

    expect([...resultados].sort()).toEqual([false, true])
  })

  it('liberarTrava solta só a trava do commit certo', async () => {
    const projectId = novoProjeto()
    const opcoes = opcoesDeProducao(projectId)
    const alvo = { numeroDoPr: NUMERO_DO_PR, headSha: 'hhh888' }

    expect(await opcoes.adquirirTrava(alvo)).toBe(true)
    await opcoes.liberarTrava({ numeroDoPr: NUMERO_DO_PR, headSha: 'outro-commit' })
    expect(await opcoes.adquirirTrava(alvo)).toBe(false)

    await opcoes.liberarTrava(alvo)
    expect(await opcoes.adquirirTrava(alvo)).toBe(true)
  })

  it('criação simultânea da ficha do PR nunca lança e deixa exatamente um dono', async () => {
    const projectId = novoProjeto()
    const agora = new Date()
    const prs = Array.from({ length: 12 }, (_, i) => 1000 + i)

    const porPr = await Promise.all(
      prs.map((numeroDoPr) =>
        Promise.all(
          Array.from({ length: 6 }, () =>
            adquirirTravaDeParecer({ prisma, projectId, numeroDoPr, headSha: 'iii999', agora })
          )
        )
      )
    )

    for (const resultados of porPr) {
      expect(resultados.filter((ok) => ok)).toHaveLength(1)
    }
  })
})
