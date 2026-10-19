import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'
import { MARCA_DO_PARECER } from '../services/parecer-do-qa.js'

// O vigia do PR, de ponta a ponta pelo relógio de verdade: um PR aberto pela
// conta do DONO do projeto, com o revisor do produto pedindo mudanças. O dono
// não olha PR (quem abre são outros robôs dele), então, em projeto `cuidar`,
// depois de um dia sem ninguém mexer o produto passa o ajuste ao dev
// automático pela MESMA retomada dos PRs do dev. Só as bordas são de mentira:
// o GitHub, o dev automático (Jules) e o banco (em memória, com estado, para
// a segunda passada enxergar o que a primeira gravou).

const GITHUB_API = 'https://api.github.com'
const JULES_API = 'https://jules.googleapis.com/v1alpha'
const HORA = 60 * 60 * 1000
const REPO = 'acme/api'
const HEAD = 'sha-do-robo'

const PROJETO = {
  id: 'proj_dono',
  wingId: REPO,
  name: 'Acme API',
  userId: 'user_dono',
  devPlan: 'pro',
  devAccountId: null,
  autonomia: 'cuidar',
  user: { githubLogin: 'dono' },
  runtimeConfig: null,
  isActive: true,
}

const PARECER =
  `${MARCA_DO_PARECER}\n<!-- gitorch:qa:tarefa:7 -->\n` +
  'GitOrch QA verdict: REQUEST CHANGES.\nFalta validar o telefone no cadastro.\n\n' +
  'GitOrch analisou este PR porque você é participante do repositório (aviso ao autor).'

interface Cenario {
  autor: string
  rotulos: string[]
  commitHaHoras: number
  /** Número do PR → tarefa de origem, como a ficha do item guarda. */
  tarefaDoPr: number | null
  autonomia: string
  parecerNoCommit: boolean
}

interface EstadoDoBanco {
  eventos: Array<{ projectId: string; createdAt: Date; payload: Record<string, unknown> }>
  sessoes: Array<{
    sessionName: string
    projectId: string
    issueNumber: number
    pullRequestNumber: number | null
    closedAt: Date | null
    closedReason: string | null
    devAccountId: string | null
  }>
}

function caminhoDoPayload(payload: Record<string, unknown>, caminho: string[]): unknown {
  let atual: unknown = payload
  for (const chave of caminho) {
    if (atual === null || typeof atual !== 'object') return undefined
    atual = (atual as Record<string, unknown>)[chave]
  }
  return atual
}

function bateEvento(e: EstadoDoBanco['eventos'][number], where: Record<string, unknown>): boolean {
  if (where['projectId'] !== undefined && where['projectId'] !== e.projectId) return false
  const criado = where['createdAt'] as { gte?: Date } | undefined
  if (criado?.gte && e.createdAt < criado.gte) return false
  const payload = where['payload'] as { path: string[]; equals: unknown } | undefined
  if (payload && caminhoDoPayload(e.payload, payload.path) !== payload.equals) return false
  const and = where['AND'] as Array<Record<string, unknown>> | undefined
  if (and && !and.every((f) => bateEvento(e, f))) return false
  return true
}

function bancoFalso(estado: EstadoDoBanco, cenario: Cenario) {
  const projeto = { ...PROJETO, autonomia: cenario.autonomia }
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      // O vigia é o único que seleciona `devPlan`; as outras varreduras do
      // relógio não enxergam projeto nenhum, de propósito.
      findMany: vi.fn(async (args: { select?: Record<string, unknown> }) =>
        args?.select?.['devPlan'] === true ? [projeto] : []
      ),
      findUnique: vi.fn(async () => ({ runtimeConfig: null, encryptedDevApiKey: null })),
      findFirst: vi.fn(async () => projeto),
    },
    user: { findUnique: vi.fn(async () => ({ githubLogin: 'dono' })) },
    devSession: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {}
        return estado.sessoes.filter((s) => {
          if (where['projectId'] !== undefined && where['projectId'] !== s.projectId) return false
          if (where['pullRequestNumber'] !== undefined && s.pullRequestNumber === null) return false
          if ('closedAt' in where && where['closedAt'] === null && s.closedAt !== null) return false
          return true
        })
      }),
      count: vi.fn(async () => estado.sessoes.filter((s) => s.closedAt === null).length),
      upsert: vi.fn(async (args: { create: EstadoDoBanco['sessoes'][number] }) => {
        const viva = estado.sessoes.find(
          (s) =>
            s.projectId === args.create.projectId &&
            s.issueNumber === args.create.issueNumber &&
            s.closedAt === null
        )
        if (viva) {
          const { Prisma } = await import('@prisma/client')
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'teste',
          })
        }
        estado.sessoes.push({
          sessionName: args.create.sessionName,
          projectId: args.create.projectId,
          issueNumber: args.create.issueNumber,
          pullRequestNumber: null,
          closedAt: null,
          closedReason: null,
          devAccountId: null,
        })
        return undefined
      }),
      updateMany: vi.fn(
        async (args: {
          where: { projectId: string; issueNumber: number; sessionName?: { startsWith: string } }
          data: Record<string, unknown>
        }) => {
          let n = 0
          for (const s of estado.sessoes) {
            if (s.projectId !== args.where.projectId) continue
            if (s.issueNumber !== args.where.issueNumber) continue
            if (s.closedAt !== null) continue
            if (
              args.where.sessionName?.startsWith &&
              !s.sessionName.startsWith(args.where.sessionName.startsWith)
            ) {
              continue
            }
            Object.assign(s, args.data)
            n += 1
          }
          return { count: n }
        }
      ),
      update: vi.fn(async () => undefined),
      findUnique: vi.fn(async () => ({ devAccountId: null })),
      findFirst: vi.fn(async () => null),
    },
    repoItem: {
      findMany: vi.fn(async () =>
        cenario.tarefaDoPr === null
          ? []
          : [
              {
                numero: 42,
                origem: 'pessoa',
                issueNumber: cenario.tarefaDoPr,
                vinculoOrigem: 'dono',
              },
            ]
      ),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => undefined),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    event: {
      count: vi.fn(
        async (args: { where: Record<string, unknown> }) =>
          estado.eventos.filter((e) => bateEvento(e, args.where)).length
      ),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const chave = (args.where['payload'] as { equals?: string } | undefined)?.equals
        return estado.eventos.find((e) => e.payload['chave'] === chave) ?? null
      }),
      findMany: vi.fn(async () => []),
      create: vi.fn(
        async (args: { data: { projectId: string; payload: Record<string, unknown> } }) => {
          estado.eventos.push({
            projectId: args.data.projectId,
            createdAt: new Date(),
            payload: args.data.payload,
          })
          return undefined
        }
      ),
    },
    agentQuestion: { findFirst: vi.fn(async () => null) },
    travaDeEntrega: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => undefined) },
    projectSchedule: { findMany: vi.fn(async () => []) },
    telegramLink: { findUnique: vi.fn(async () => null) },
  }
}

const ENV_KEYS = [
  'NODE_ENV',
  'GITORCH_SCHEDULER_TICK_MS',
  'GITORCH_SCHEDULER_TICK_RAPIDO_MS',
  'GITORCH_GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITORCH_EXECUTOR',
  'JULES_API_KEY',
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'GITORCH_DEV_BASE_BRANCH',
  'GITORCH_ESPERA_PEDIDO_DO_DONO_HORAS',
]

describe('PR da conta do dono parado — vigia pelo relógio real (real seam)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let apps: Array<ReturnType<typeof Fastify>> = []

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      original[key] = process.env[key]
      delete process.env[key]
    }
    process.env['NODE_ENV'] = 'production'
    // O tique principal nunca dispara dentro do teste; o rápido sim.
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '3600000'
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '20'
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
    process.env['JULES_API_KEY'] = 'chave-do-dev-de-teste'
  })

  afterEach(async () => {
    for (const a of apps) await a.close()
    apps = []
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  function github(
    cenario: Cenario,
    sessoesCriadas: Array<{ prompt: string; title: string; startingBranch: string }>,
    listagens: { n: number }
  ) {
    const commitEm = new Date(Date.now() - cenario.commitHaHoras * HORA).toISOString()
    return vi.fn(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const metodo = (init?.method ?? 'GET').toUpperCase()
      const resposta = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200 })

      if (u === `${JULES_API}/sessions` && metodo === 'POST') {
        const corpo = JSON.parse(String(init?.body ?? '{}')) as {
          prompt: string
          title: string
          sourceContext: { githubRepoContext: { startingBranch: string } }
        }
        sessoesCriadas.push({
          prompt: corpo.prompt,
          title: corpo.title,
          startingBranch: corpo.sourceContext.githubRepoContext.startingBranch,
        })
        return resposta({ name: `sessions/nova-${sessoesCriadas.length}` })
      }
      if (u.startsWith(`${GITHUB_API}/repos/${REPO}/pulls?state=open`)) {
        listagens.n += 1
        return resposta([
          {
            number: 42,
            user: { login: cenario.autor },
            labels: cenario.rotulos.map((name) => ({ name })),
            body: 'ajuste feito por um robô',
            draft: false,
            head: { sha: HEAD, ref: 'ajuste-do-robo', repo: { full_name: REPO } },
          },
        ])
      }
      if (u === `${GITHUB_API}/repos/${REPO}/pulls/42`) return resposta({ mergeable: true })
      if (u === `${GITHUB_API}/repos/${REPO}/commits/${HEAD}`) {
        return resposta({ commit: { committer: { date: commitEm } } })
      }
      if (u.includes(`/commits/${HEAD}/check-runs`)) {
        return resposta({ check_runs: [{ status: 'completed', conclusion: 'success' }] })
      }
      if (u.includes('/actions/runs')) {
        return resposta({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] })
      }
      if (u.includes('/pulls/42/reviews')) {
        return resposta(
          cenario.parecerNoCommit
            ? [
                {
                  body: PARECER,
                  commit_id: HEAD,
                  submitted_at: new Date(
                    Date.now() - cenario.commitHaHoras * HORA + 60_000
                  ).toISOString(),
                  user: { login: 'gitorch-ai[bot]', type: 'Bot' },
                },
              ]
            : []
        )
      }
      if (u.includes('/comments')) return resposta([])
      if (u.includes('/issues/')) return resposta({ state: 'open' })
      return resposta({})
    })
  }

  async function subir(
    estado: EstadoDoBanco,
    cenario: Cenario,
    sessoesCriadas: Parameters<typeof github>[1]
  ) {
    const listagens = { n: 0 }
    global.fetch = github(cenario, sessoesCriadas, listagens) as unknown as typeof fetch
    const app = Fastify({ logger: false })
    app.decorate('prisma', bancoFalso(estado, cenario) as never)
    apps.push(app)
    await app.register(schedulerPlugin)
    await vi.waitFor(() => expect(listagens.n).toBeGreaterThanOrEqual(1), { timeout: 4000 })
    // Deixa a passada terminar de gravar o que decidiu.
    await new Promise((resolve) => setTimeout(resolve, 250))
    return { app, listagens }
  }

  function umaPassada(sobrepor: Partial<Cenario> = {}): Cenario {
    return {
      autor: 'dono',
      rotulos: [],
      commitHaHoras: 25,
      tarefaDoPr: 7,
      autonomia: 'cuidar',
      parecerNoCommit: true,
      ...sobrepor,
    }
  }

  const novoEstado = (): EstadoDoBanco => ({ eventos: [], sessoes: [] })

  test('cuidar, parecer pedindo mudanças e 25 h sem ninguém mexer: uma sessão do dev, partindo da principal, com o parecer e o ramo do dono', async () => {
    const estado = novoEstado()
    const criadas: Parameters<typeof github>[1] = []
    await subir(estado, umaPassada(), criadas)

    expect(criadas).toHaveLength(1)
    expect(criadas[0]!.startingBranch).toBe('main')
    expect(criadas[0]!.title).toContain('#42')
    expect(criadas[0]!.prompt).toContain('Falta validar o telefone no cadastro.')
    expect(criadas[0]!.prompt).toContain('ajuste-do-robo')
    expect(criadas[0]!.prompt).not.toContain('GitOrch analisou este PR')

    // A sessão ficou ligada ao PR do dono (é o que permite substituí-lo depois)
    // e a decisão virou evento (é o que conta o teto).
    expect(estado.sessoes).toHaveLength(1)
    expect(estado.sessoes[0]).toMatchObject({ issueNumber: 7, pullRequestNumber: 42 })
    const retomadas = estado.eventos.filter(
      (e) => caminhoDoPayload(e.payload, ['vigiaDoPr', 'acao']) === 'retomar'
    )
    expect(retomadas).toHaveLength(1)
    expect(String(retomadas[0]!.payload['texto'])).toContain('conta do dono')
  })

  test('segunda passada, com a sessão já encerrada: o teto impede outra sessão', async () => {
    const estado = novoEstado()
    const criadas: Parameters<typeof github>[1] = []
    await subir(estado, umaPassada(), criadas)
    expect(criadas).toHaveLength(1)

    for (const s of estado.sessoes) {
      s.closedAt = new Date()
      s.closedReason = 'completed'
    }
    await subir(estado, umaPassada(), criadas)

    expect(criadas).toHaveLength(1)
  })

  test('23 h sem ninguém mexer: não toca e registra uma vez que aguarda quem abriu', async () => {
    const estado = novoEstado()
    const criadas: Parameters<typeof github>[1] = []
    await subir(estado, umaPassada({ commitHaHoras: 23 }), criadas)
    await subir(estado, umaPassada({ commitHaHoras: 23 }), criadas)

    expect(criadas).toHaveLength(0)
    const avisos = estado.eventos.filter((e) =>
      String(e.payload['texto'] ?? '').includes('aguardando quem abriu')
    )
    expect(avisos).toHaveLength(1)
  })

  test('rótulo de não mexer: nenhuma sessão, mesmo com dias parado', async () => {
    const estado = novoEstado()
    const criadas: Parameters<typeof github>[1] = []
    await subir(estado, umaPassada({ rotulos: ['gitorch:nao-mexer'], commitHaHoras: 99 }), criadas)
    expect(criadas).toHaveLength(0)
  })

  test('PR de colaborador (não é o dono): nenhuma sessão, nenhum fechamento', async () => {
    const estado = novoEstado()
    const criadas: Parameters<typeof github>[1] = []
    await subir(estado, umaPassada({ autor: 'colaborador', commitHaHoras: 99 }), criadas)
    expect(criadas).toHaveLength(0)
    expect(estado.sessoes).toHaveLength(0)
    expect(estado.eventos).toHaveLength(0)
  })

  test.each(['sugerir', 'so_olhar'])('autonomia %s: nenhuma sessão', async (autonomia) => {
    const estado = novoEstado()
    const criadas: Parameters<typeof github>[1] = []
    await subir(estado, umaPassada({ autonomia, commitHaHoras: 99 }), criadas)
    expect(criadas).toHaveLength(0)
  })

  test('sem tarefa de origem: não consegue abrir sessão e diz isso uma vez', async () => {
    const estado = novoEstado()
    const criadas: Parameters<typeof github>[1] = []
    await subir(estado, umaPassada({ tarefaDoPr: null }), criadas)
    expect(criadas).toHaveLength(0)
    const avisos = estado.eventos.filter((e) =>
      String(e.payload['texto'] ?? '').includes('não está ligado a nenhuma tarefa')
    )
    expect(avisos).toHaveLength(1)
  })
})
