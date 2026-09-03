import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// L4-T19 / achado A (revisão do fix-up 2) — o "aviso de publicação" (D50: o
// produto pede ao CD do cliente que avise quando a versão sobe) NUNCA
// nascia, em NENHUM nível de autonomia: `pedirOAvisoDePublicacao`
// (scheduler.ts) chamava `criarIssueDeDesejo` sem passar `fetchImpl`
// nenhum — o padrão sem guarda (`fetchSemPermissao`) recusa toda escrita, e
// a exceção morria em silêncio no `catch` de fora. Este arquivo prova, no
// seam REAL (relógio -> varrerPublicacoes -> pedirOAvisoDePublicacao ->
// nascerDesejo -> POST real, na rede mockada), que a correção (`nascerDesejo`,
// achado A) fecha o buraco: nasce em "cuidar", é barrada com log em
// "só olhar" — a mesma prova que `scheduler-conserto-de-publicacao-real-seam.test.ts`
// já faz para a tarefa de conserto.

const SHA = 'deadbeefcafe1234567890abcdef1234567890ab'

/** Declarado pelo dono: publica na própria VM — fora do alcance do GitHub, o
 *  produto não tem o que ler e passa direto para "esperar-aviso" (D49),
 *  sem precisar descobrir mecanismo nenhum no repositório. */
const PROJETO_VM_PROPRIA = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  runtimeConfig: { publicacao: { como: 'publica-em-vm-propria' } },
  isActive: true,
  deployNoticeInstalledAt: null,
  deployNoticeAskedKey: null,
  autonomia: 'cuidar',
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

/** Prisma falso COM ESTADO — mesmo desenho de `scheduler-conserto-de-publicacao-real-seam.test.ts`:
 *  `update` de `project` é aplicado na linha devolvida pelo `findUnique`
 *  seguinte, para a marca de dedup (`deployNoticeAskedKey`) ficar honesta. */
function buildFakePrisma(
  projeto: Record<string, unknown>,
  sessao: Record<string, unknown>
): Record<string, unknown> & { _projeto: Record<string, unknown> } {
  const linhaDoProjeto = { ...projeto }
  const linhaDaSessao = { ...sessao }
  return {
    _projeto: linhaDoProjeto,
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => ({ ...linhaDoProjeto })),
      findMany: vi.fn(async () => []),
      // `nascerDesejo` (achado A) lê a autonomia REAL na hora de escrever,
      // pelo `wingId` — sem este mock, `findFirst` não existe e a issue
      // nunca nasce, em NENHUM nível (o oposto do que este arquivo prova).
      findFirst: vi.fn(async (args: { where?: { wingId?: string } }) =>
        args?.where?.wingId === (linhaDoProjeto['wingId'] as string)
          ? { autonomia: linhaDoProjeto['autonomia'] }
          : null
      ),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        Object.assign(linhaDoProjeto, args.data)
        return { ...linhaDoProjeto }
      }),
    },
    devSession: {
      findMany: vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
        if (!args?.where?.mergeCommitSha) return []
        if (linhaDaSessao['closedAt'] !== null) return []
        return [linhaDaSessao]
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        Object.assign(linhaDaSessao, args.data)
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
  'GITORCH_PUBLIC_URL',
]

function buildFetchMock(opcoes: { issueCriada?: number }) {
  return vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const u = String(url)
    const metodo = (init?.method ?? 'GET').toUpperCase()
    // A leitura de dedup ("já existe o pedido aberto?") — sempre vazia
    // aqui, para nunca curto-circuitar antes da escrita real que este
    // arquivo prova.
    if (u.startsWith('https://api.github.com/repos/acme/api/issues?') && metodo === 'GET') {
      return new Response(JSON.stringify([]), { status: 200 })
    }
    if (u === 'https://api.github.com/repos/acme/api/issues' && metodo === 'POST') {
      return new Response(JSON.stringify({ number: opcoes.issueCriada ?? 555 }), { status: 201 })
    }
    // `nascerDesejo` sempre tenta resolver o quadro (leitura, nunca
    // guardada) — sem `engineConnections` decorado neste app de teste, a
    // credencial não resolve e o quadro fica `undefined`, best-effort; a
    // issue nasce igual, sem card. Isto é best-effort de propósito, então
    // uma resposta vazia (sem `projectsV2`) já basta.
    if (u === 'https://api.github.com/graphql' && metodo === 'POST') {
      return new Response(JSON.stringify({ data: { repository: null } }), { status: 200 })
    }
    if (u.startsWith('https://api.telegram.org/')) {
      return new Response('{"ok":true}', { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
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

describe('o aviso de publicação (D50) nasce de verdade, com a autonomia do projeto (real seam, L4-T19)', () => {
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
    // Sem isto `pedirOAvisoDePublicacao` desiste antes de tentar nada — não
    // é o que este arquivo prova, então fica sempre presente.
    process.env['GITORCH_PUBLIC_URL'] = 'https://app.gitorch.dev'
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

  test('no nível "cuidar", o pedido de aviso NASCE no repositório do cliente', async () => {
    const prisma = buildFakePrisma({ ...PROJETO_VM_PROPRIA, autonomia: 'cuidar' }, linhaDeSessao())
    const fetchMock = buildFetchMock({ issueCriada: 555 })

    await rodarTique(prisma, fetchMock, () => {
      expect(issuesCriadas(fetchMock)).toHaveLength(1)
    })

    const issue = issuesCriadas(fetchMock)[0]!
    expect(issue.title).toContain('Avisar')
    expect(issue.labels).toContain('gitorch:task')
    // A marca de dedup ficou gravada no PROJETO (o pedido é do projeto, não
    // da entrega — vale para todas as sessões seguintes).
    await vi.waitFor(() =>
      expect(prisma._projeto['deployNoticeAskedKey']).toBe('gitorch:instalar-aviso-de-publicacao')
    )
  })

  // A prova central da autonomia, no seam REAL (relógio -> serviço -> fetch):
  // no nível "só olhar" a escrita é BARRADA NA PORTA — a chamada existe,
  // chega na saída de rede e é recusada, com log (nunca em silêncio e nunca
  // como se o GitHub tivesse falhado).
  test('no nível "só olhar", o pedido de aviso NÃO é escrito no repositório do cliente', async () => {
    const prisma = buildFakePrisma(
      { ...PROJETO_VM_PROPRIA, autonomia: 'so_olhar' },
      linhaDeSessao()
    )
    const fetchMock = buildFetchMock({ issueCriada: 555 })

    global.fetch = fetchMock as unknown as typeof fetch
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    // Espera o tique atravessar por inteiro: o mesmo tempo que o caminho
    // autorizado leva para abrir a issue. Se em algum momento aparecesse
    // uma, este teste falharia — e é isso que ele existe para vigiar.
    await new Promise((r) => setTimeout(r, 300))

    expect(issuesCriadas(fetchMock)).toHaveLength(0)
    // E a marca de dedup NÃO pode ter sido gravada: gravar sem a issue
    // existir deixaria o projeto marcado como "já pedido" para sempre, e o
    // pedido nunca mais seria tentado quando o dono mudar a autonomia.
    expect(prisma._projeto['deployNoticeAskedKey']).toBeNull()
  })
})
