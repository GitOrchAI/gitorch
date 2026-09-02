import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// A publicação que falha VOLTA ATRÁS: vira tarefa de conserto no repositório
// do cliente — e o ensaio do ambiente reprovado, também.
//
// O risco que este arquivo cobre é o mesmo já nomeado no "real seam" da
// vigília pós-merge: uma peça pode estar 100% correta em isolamento e nunca
// rodar em produção, porque o ponto de chamada dentro do fechamento
// não-exportado do relógio nunca a chama. Aqui o `schedulerPlugin` de
// VERDADE é registrado e o `setInterval` de produção dispara o tique; dali em
// diante é tudo código real: tick -> varrerPublicacoes -> acompanharPublicacao
// -> decidirConsertoDePublicacao -> criarIssueDeDesejo (POST real, na rede
// mockada) -> marca de dedup na linha da sessão.

const SHA = 'deadbeefcafe1234567890abcdef1234567890ab'

const PROJETO_SEM_AMBIENTE = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: null,
  isActive: true,
  // Projeto que JÁ opera com o ciclo fechado — é o estado em que a migração
  // deixa todo projeto que já existia. Sem isto a guarda de autonomia recusa a
  // abertura da tarefa de conserto, e com razão: no nível padrão o produto não
  // escreve no repositório de ninguém.
  autonomia: 'cuidar',
} as const

const PROJETO_COM_AMBIENTE = {
  ...PROJETO_SEM_AMBIENTE,
  runtimeConfig: { ambientes: { endereco: 'https://loja.exemplo.com', caminhos: ['/'] } },
} as const

/** Ambiente do cliente numa rede interna: jamais alcançável a partir daqui. */
const PROJETO_EM_REDE_INTERNA = {
  ...PROJETO_SEM_AMBIENTE,
  runtimeConfig: { ambientes: { endereco: 'http://127.0.0.1:3011', caminhos: ['/'] } },
} as const

function linhaDeSessao(extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sess_1',
    projectId: 'proj_1',
    issueNumber: 5,
    sessionName: 'sessions/abc',
    state: 'COMPLETED',
    answeredHash: null,
    pullRequestNumber: 7,
    attempts: 1,
    nudges: 0,
    lastProgressAt: null,
    // Recente: sem isto o teto absoluto (24h) fecharia a sessão antes de a
    // decisão de conserto ser sequer alcançada.
    stateCheckedAt: new Date(),
    reworkNoticePending: null,
    reworkNoticeAttempts: 0,
    pendingSince: null,
    mergeCommitSha: SHA,
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    deployFixKey: null,
    envLastVerdict: null,
    closedAt: null,
    ...extras,
  }
}

/**
 * Prisma falso COM ESTADO: cada `update` é aplicado na linha devolvida pelo
 * `findMany` seguinte. É o que torna as contagens deste arquivo honestas —
 * com uma linha imutável, a cadência nunca avançaria e o tique reexaminaria
 * a mesma sessão para sempre, inflando qualquer "exatamente uma vez".
 */
function buildFakePrisma(
  projeto: Record<string, unknown>,
  sessao: Record<string, unknown>
): Record<string, unknown> & { _linha: Record<string, unknown> } {
  const linha = { ...sessao }
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  return {
    _linha: linha,
    _updateCalls: updateCalls,
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => projeto),
      findMany: vi.fn(async () => []),
      // `nascerDesejo` (achado A, revisão do fix-up 2) lê a autonomia REAL
      // na hora de escrever, pelo `wingId` — o MESMO caminho que
      // `guarda-de-autonomia.ts`/`routes/index.ts` já usam. Sem este mock,
      // a leitura estoura (`findFirst` não existe) e a tarefa de conserto
      // nunca abre, em NENHUM nível — o oposto do que este arquivo prova.
      findFirst: vi.fn(async (args: { where?: { wingId?: string } }) =>
        args?.where?.wingId === (projeto['wingId'] as string)
          ? { autonomia: projeto['autonomia'] }
          : null
      ),
    },
    devSession: {
      findMany: vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
        if (!args?.where?.mergeCommitSha) return []
        if (linha['closedAt'] !== null) return []
        return [linha]
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        Object.assign(linha, args.data)
        return undefined
      }),
    },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
  } as never
}

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_EXECUTOR',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
]

type RespostaDeAmbiente = { status: number } | { erro: true }

/**
 * Rede do GitHub e do ambiente publicado. `etapas` decide o veredito da
 * publicação; `ambiente` decide o do ensaio.
 */
function buildFetchMock(opcoes: {
  etapas: Array<{ name: string; status: string; conclusion: string | null }>
  ambiente?: RespostaDeAmbiente
  issueCriada?: number
}) {
  return vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    if (u.endsWith('/repos/acme/api/environments')) {
      return new Response(JSON.stringify({ environments: [] }), { status: 200 })
    }
    if (u.endsWith('/repos/acme/api/actions/workflows')) {
      return new Response(
        JSON.stringify({
          workflows: [{ name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' }],
        }),
        { status: 200 }
      )
    }
    if (u.includes('/actions/workflows/deploy.yml/runs')) {
      return new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: 99,
              name: 'Deploy',
              event: 'push',
              status: 'completed',
              conclusion: 'failure',
              head_branch: 'main',
              head_sha: SHA,
              run_started_at: new Date().toISOString(),
            },
          ],
        }),
        { status: 200 }
      )
    }
    if (u.endsWith('/actions/runs/99/jobs')) {
      return new Response(JSON.stringify({ jobs: opcoes.etapas }), { status: 200 })
    }
    if (u === 'https://api.github.com/repos/acme/api/issues' && init?.method === 'POST') {
      return new Response(JSON.stringify({ number: opcoes.issueCriada ?? 321 }), { status: 201 })
    }
    // Comparação EXATA de origem, nunca `startsWith`: um prefixo sem barra
    // final também casa com `https://loja.exemplo.com.dominio-alheio.com`.
    // É o mesmo padrão que já produziu alerta de severidade alta neste
    // repositório; num teste não há risco, mas o portão é zero-tolerância e
    // a regra é boa — o hábito é que protege o código de produção.
    if (origemDe(u) === 'https://loja.exemplo.com') {
      const ambiente = opcoes.ambiente ?? { status: 200 }
      if ('erro' in ambiente) throw new Error('conexão recusada')
      return new Response('ok', { status: ambiente.status })
    }
    if (u.startsWith('https://api.telegram.org/')) {
      return new Response('{"ok":true}', { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

/** Origem do endereço, ou string vazia quando não é um endereço absoluto. */
function origemDe(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function issuesCriadas(fetchMock: ReturnType<typeof buildFetchMock>): Array<{
  title: string
  body: string
  labels: string[]
}> {
  return fetchMock.mock.calls
    .filter(
      ([u, init]) =>
        String(u) === 'https://api.github.com/repos/acme/api/issues' &&
        (init as RequestInit | undefined)?.method === 'POST'
    )
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
}

function avisosDeTelegram(fetchMock: ReturnType<typeof buildFetchMock>): string[] {
  return fetchMock.mock.calls
    .filter(([u]) => String(u).startsWith('https://api.telegram.org/'))
    .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { text: string }).text)
}

const ETAPAS_QUE_FALHAM = [
  { name: 'build', status: 'completed', conclusion: 'success' },
  { name: 'deploy prod', status: 'completed', conclusion: 'failure' },
]
const ETAPAS_QUE_PASSAM = [
  { name: 'build', status: 'completed', conclusion: 'success' },
  { name: 'deploy prod', status: 'completed', conclusion: 'success' },
]

describe('a publicação que falha volta atrás como tarefa de conserto (real seam)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '15'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-de-teste'
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  async function rodarTique(
    prisma: ReturnType<typeof buildFakePrisma>,
    fetchMock: ReturnType<typeof buildFetchMock>,
    ate: () => void
  ): Promise<void> {
    global.fetch = fetchMock as unknown as typeof fetch
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await vi.waitFor(ate, { timeout: 3000, interval: 10 })
  }

  // A prova central da autonomia, no seam REAL (relógio -> serviço -> fetch):
  // no nível "só olhar" a escrita é BARRADA NA PORTA. Não é "o código não
  // chamou" — é a chamada existir, chegar na saída de rede e ser recusada.
  test('no nível "só olhar", a tarefa de conserto NÃO é aberta no repositório do cliente', async () => {
    const prisma = buildFakePrisma(
      { ...PROJETO_SEM_AMBIENTE, autonomia: 'so_olhar' },
      linhaDeSessao()
    )
    const fetchMock = buildFetchMock({ etapas: ETAPAS_QUE_FALHAM, issueCriada: 321 })

    global.fetch = fetchMock as unknown as typeof fetch
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Espera o tique atravessar por inteiro: o mesmo tempo que o caminho
    // autorizado leva para abrir a issue. Se em algum momento aparecesse uma,
    // este teste falharia — e é isso que ele existe para vigiar.
    await new Promise((r) => setTimeout(r, 300))

    expect(issuesCriadas(fetchMock)).toHaveLength(0)
    // E a marca de dedup NÃO pode ter sido gravada: gravar sem a issue existir
    // deixaria a sessão marcada como "já consertada" para sempre, e o conserto
    // nunca mais seria tentado.
    const atualizacoes = (prisma['devSession'] as { update: { mock: { calls: unknown[][] } } })
      .update.mock.calls
    expect(atualizacoes.some((c) => JSON.stringify(c).includes('deployNotice'))).toBe(false)
  })

  test('o MESMO cenário no nível "cuidar" abre a tarefa — a diferença é só a autorização', async () => {
    const prisma = buildFakePrisma(
      { ...PROJETO_SEM_AMBIENTE, autonomia: 'cuidar' },
      linhaDeSessao()
    )
    const fetchMock = buildFetchMock({ etapas: ETAPAS_QUE_FALHAM, issueCriada: 321 })

    await rodarTique(prisma, fetchMock, () => {
      expect(issuesCriadas(fetchMock)).toHaveLength(1)
    })
  })

  test('publicação que falhou abre UMA tarefa de conserto no padrão Shrimp, marca o dedup e NÃO fecha a entrega', async () => {
    const prisma = buildFakePrisma(PROJETO_SEM_AMBIENTE, linhaDeSessao())
    const fetchMock = buildFetchMock({ etapas: ETAPAS_QUE_FALHAM, issueCriada: 321 })

    await rodarTique(prisma, fetchMock, () => {
      expect(issuesCriadas(fetchMock)).toHaveLength(1)
    })

    const issue = issuesCriadas(fetchMock)[0]!
    expect(issue.title).toContain('Conserto')
    for (const cabecalho of [
      'Goal',
      'Task Details',
      'Task Description',
      'Implementation Guide',
      'Verification Criteria',
      'Dependencies',
      'Related Files',
      'Notes',
    ]) {
      expect(issue.body, `seção "${cabecalho}" ausente`).toContain(`## ${cabecalho}`)
    }
    // A issue nasce DELEGÁVEL — sem este label o Scrum Master nunca a pega.
    expect(issue.labels).toContain('gitorch:task')
    // E ligada à entrega que quebrou: commit, PR e tarefa de origem.
    expect(issue.body).toContain(SHA)
    expect(issue.body).toContain('#7')
    expect(issue.body).toContain('#5')
    expect(issue.body).toContain('deploy prod')

    // O dedup ficou gravado na própria linha da sessão.
    expect(prisma._linha['deployFixKey']).toBe(`gitorch:conserto:publicacao:${SHA}`)

    // A entrega NÃO fecha: ela continua sem estar no ar, e fechar seria
    // mentir para o quadro do cliente.
    expect(prisma._linha['closedAt']).toBeNull()

    // Um aviso só, carregando o número da tarefa de conserto.
    const avisos = avisosDeTelegram(fetchMock)
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('#321')
  })

  test('a mesma falha reexaminada não abre uma segunda issue no repositório do cliente', async () => {
    const prisma = buildFakePrisma(
      PROJETO_SEM_AMBIENTE,
      linhaDeSessao({
        deployFixKey: `gitorch:conserto:publicacao:${SHA}`,
        deployState: 'falhou',
      })
    )
    const fetchMock = buildFetchMock({ etapas: ETAPAS_QUE_FALHAM })

    await rodarTique(prisma, fetchMock, () => {
      // A varredura chegou até o fim (carimbou a cadência da publicação).
      expect(prisma._linha['deployCheckedAt']).not.toBeNull()
    })

    expect(issuesCriadas(fetchMock)).toHaveLength(0)
    // Sem issue nova e sem mudança de estado, o dono também não é reavisado.
    expect(avisosDeTelegram(fetchMock)).toHaveLength(0)
  })
})

describe('o ensaio do ambiente reprovado também vira tarefa de conserto (real seam)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '15'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    process.env['GITORCH_TELEGRAM_BOT_TOKEN'] = 'bot-token-de-teste'
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  async function rodarTique(
    prisma: ReturnType<typeof buildFakePrisma>,
    fetchMock: ReturnType<typeof buildFetchMock>,
    ate: () => void
  ): Promise<void> {
    global.fetch = fetchMock as unknown as typeof fetch
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)
    await vi.waitFor(ate, { timeout: 3000, interval: 10 })
  }

  test('publicou, mas a tela respondeu com erro: abre a tarefa de conserto com a evidência da tela e o código HTTP', async () => {
    const prisma = buildFakePrisma(PROJETO_COM_AMBIENTE, linhaDeSessao())
    const fetchMock = buildFetchMock({
      etapas: ETAPAS_QUE_PASSAM,
      ambiente: { status: 503 },
      issueCriada: 654,
    })

    await rodarTique(prisma, fetchMock, () => {
      expect(issuesCriadas(fetchMock)).toHaveLength(1)
    })

    const issue = issuesCriadas(fetchMock)[0]!
    expect(issue.body).toContain('503')
    expect(issue.body).toContain('https://loja.exemplo.com')
    expect(issue.labels).toContain('gitorch:task')
    expect(prisma._linha['deployFixKey']).toBe(`gitorch:conserto:ambiente:${SHA}`)

    // Aqui a publicação foi confirmada — a entrega FECHA, e o aviso ao dono
    // diz as duas coisas: foi ao ar, e o ensaio reprovou com conserto aberto.
    await vi.waitFor(() => expect(prisma._linha['closedAt']).not.toBeNull(), { timeout: 3000 })
    const avisos = avisosDeTelegram(fetchMock)
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toContain('#654')
    expect(avisos[0]).toContain('falhou')
  })

  test('ambiente inalcançável numa leitura só NÃO vira tarefa: guarda a leitura e adia o fecho da entrega', async () => {
    const prisma = buildFakePrisma(PROJETO_COM_AMBIENTE, linhaDeSessao())
    const fetchMock = buildFetchMock({ etapas: ETAPAS_QUE_PASSAM, ambiente: { erro: true } })

    await rodarTique(prisma, fetchMock, () => {
      expect(prisma._linha['envLastVerdict']).toBe('inalcancavel')
    })

    // Uma queda de rede de trinta segundos não pode virar ruído no quadro do
    // cliente — e a entrega também não pode ser dada por terminada sem saber.
    expect(issuesCriadas(fetchMock)).toHaveLength(0)
    expect(prisma._linha['closedAt']).toBeNull()
  })

  test('inalcançável de novo na leitura seguinte: aí sim vira tarefa de conserto', async () => {
    const prisma = buildFakePrisma(
      PROJETO_COM_AMBIENTE,
      linhaDeSessao({ envLastVerdict: 'inalcancavel', deployState: 'no-ar' })
    )
    const fetchMock = buildFetchMock({
      etapas: ETAPAS_QUE_PASSAM,
      ambiente: { erro: true },
      issueCriada: 777,
    })

    await rodarTique(prisma, fetchMock, () => {
      expect(issuesCriadas(fetchMock)).toHaveLength(1)
    })

    expect(prisma._linha['deployFixKey']).toBe(`gitorch:conserto:ambiente:${SHA}`)
    await vi.waitFor(() => expect(prisma._linha['closedAt']).not.toBeNull(), { timeout: 3000 })
  })

  test('endereço que a guarda de rede recusa nunca vira tarefa: é limitação de alcance, não defeito do cliente', async () => {
    const prisma = buildFakePrisma(PROJETO_EM_REDE_INTERNA, linhaDeSessao())
    const fetchMock = buildFetchMock({ etapas: ETAPAS_QUE_PASSAM })

    await rodarTique(prisma, fetchMock, () => {
      expect(prisma._linha['closedAt']).not.toBeNull()
    })

    // Nem tarefa no quadro do cliente, nem entrega presa esperando uma
    // segunda leitura que daria exatamente o mesmo resultado para sempre.
    expect(issuesCriadas(fetchMock)).toHaveLength(0)
    expect(prisma._linha['envLastVerdict']).toBe('inalcancavel')
    expect(prisma._linha['deployFixKey']).toBeNull()
  })

  test('projeto sem endereço de ambiente configurado nunca vira tarefa de conserto', async () => {
    const prisma = buildFakePrisma(PROJETO_SEM_AMBIENTE, linhaDeSessao())
    const fetchMock = buildFetchMock({ etapas: ETAPAS_QUE_PASSAM })

    await rodarTique(prisma, fetchMock, () => {
      expect(prisma._linha['closedAt']).not.toBeNull()
    })

    expect(issuesCriadas(fetchMock)).toHaveLength(0)
    expect(prisma._linha['envLastVerdict']).toBe('sem-endereco')
  })
})
