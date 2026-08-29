import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import { schedulerPlugin } from './scheduler.js'

// Item 2 da revisão pós-Leva A ("o quadro do cliente ainda mente sobre o
// progresso"): antes desta correção, `fecharTarefaEntregue` e o card indo
// para "done" aconteciam no MERGE (`qa-rails-mission.ts`), sem o produto
// saber se aquele código chegaria a ir ao ar. Se a publicação falhasse
// depois, nada reabria a tarefa nem voltava o card — o board do cliente
// dizia "entregue" enquanto o site nunca recebeu a mudança.
//
// Este arquivo prova, pelo "real seam" (mesmo padrão do resto desta família
// de testes: registra o `schedulerPlugin` de VERDADE e deixa o próprio
// `setInterval` disparar), os três cenários que o dono pediu:
// - publicação com veredito POSITIVO: a tarefa fecha como entregue, o card
//   vai para "done".
// - publicação que não confirma dentro do prazo: a tarefa NÃO fecha como
//   entregue, ganha um comentário explicando o motivo, o card volta para
//   "review".
// - repositório que PROVADAMENTE não publica: o merge já é a entrega —
//   fecha prontamente, sem esperar um veredito que nunca viria.
const PROJETO = {
  id: 'proj_1',
  wingId: 'acme/api',
  name: 'Acme API',
  userId: 'user_1',
  // Board próprio configurado — é o que faz `resolveRailsBoard` devolver
  // algo e `resolverEntregaDoBoard` tentar mover o card, não só a tarefa.
  runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'acme/9' } },
  isActive: true,
  // Mover card é ESCRITA no quadro do cliente e passa pela guarda de
  // autonomia. Este é o estado de um projeto que já opera com o ciclo fechado
  // — o mesmo em que a migração deixa todo projeto que já existia.
  autonomia: 'cuidar',
} as const

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

// IDs do campo "Status" do board fake — nomeados por coluna para as
// asserções lerem como texto, não como posição num array.
const OPCOES_DE_STATUS = [
  { id: 'O_TODO', name: 'Todo' },
  { id: 'O_INPROGRESS', name: 'In Progress' },
  { id: 'O_REVIEW', name: 'In Review' },
  { id: 'O_DONE', name: 'Done' },
  { id: 'O_BLOCKED', name: 'Blocked' },
]

function buildFakePrisma(sessaoInicial: Record<string, unknown>) {
  const updateCalls: Array<{ where: unknown; data: Record<string, unknown> }> = []
  let sessaoAtual: Record<string, unknown> = { ...sessaoInicial }
  return {
    mission: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    project: {
      findUnique: vi.fn(async () => PROJETO),
      findMany: vi.fn(async () => []),
    },
    devSession: {
      findMany: vi.fn(async (args: { where?: { mergeCommitSha?: unknown } }) => {
        if (args?.where?.mergeCommitSha) {
          return sessaoAtual['closedAt'] === null ? [sessaoAtual] : []
        }
        return []
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        updateCalls.push(args)
        sessaoAtual = { ...sessaoAtual, ...args.data }
        return undefined
      }),
    },
    projectSchedule: {
      findMany: vi.fn(async () => []),
    },
    telegramLink: {
      findUnique: vi.fn(async () => ({ status: 'linked', chatId: 'chat-do-dono' })),
    },
    _updateCalls: updateCalls,
  }
}

/**
 * Fetch fake compartilhado pelos três cenários — REST (deployments,
 * issues) + GraphQL (Projects v2, mesmo formato de
 * `board-status.test.ts:fakeGithub`, adaptado para o "real seam": o
 * `createCardMover` real dentro de `resolverEntregaDoBoard` usa o `fetch`
 * GLOBAL (nenhum call site em scheduler.ts passa `fetchImpl`), então
 * mockar `global.fetch` já intercepta as chamadas GraphQL também.
 */
function fakeGithubBoard(opts: {
  environments?: Array<{ name: string }>
  deployments?: Array<{
    id: number
    environment: string
    sha: string
    production_environment: boolean
    transient_environment: boolean
  }>
  statuses?: Array<{ state: string; environment_url: string | null; created_at: string }>
}) {
  const comentarios: Array<{ body?: string }> = []
  const fechamentos: Array<{ state?: string }> = []
  const graphqlCalls: Array<{ query: string; variables: Record<string, unknown> }> = []

  const impl = vi.fn(
    async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = String(url)
      const method = init?.method ?? 'GET'
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200 })

      if (u.endsWith('/graphql')) {
        const body = JSON.parse(String(init?.body)) as {
          query: string
          variables: Record<string, unknown>
        }
        graphqlCalls.push(body)
        if (body.query.includes('fields(first: 50)')) {
          return json({
            data: {
              node: {
                fields: { nodes: [{ id: 'F1', name: 'Status', options: OPCOES_DE_STATUS }] },
              },
            },
          })
        }
        if (body.query.includes('UpdateProjectV2SingleSelectField')) {
          return json({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'IT1' } } } })
        }
        if (
          body.query.includes('addProjectV2ItemById') ||
          body.query.includes('AddProjectV2ItemById')
        ) {
          return json({ data: { addProjectV2ItemById: { item: { id: 'IT1' } } } })
        }
        if (body.query.includes('GetProjectId') || body.query.includes('projectV2(number')) {
          return json({ data: { user: { projectV2: { id: 'P1' } } } })
        }
        return json({ data: {} })
      }

      if (u.endsWith('/repos/acme/api/environments')) {
        return json({ environments: opts.environments ?? [] })
      }
      if (u.endsWith('/repos/acme/api/actions/workflows')) {
        return json({ workflows: [] })
      }
      if (u.includes('/repos/acme/api/deployments?')) {
        return json(opts.deployments ?? [])
      }
      if (u.match(/\/repos\/acme\/api\/deployments\/\d+\/statuses/)) {
        return json(opts.statuses ?? [])
      }
      // Mesma rota atende `lerEstadoDaTarefa` (fecharTarefaEntregue) e o
      // lookup do node_id (card-mover) — os dois consumidores leem campos
      // diferentes da MESMA resposta.
      if (u.endsWith('/repos/acme/api/issues/5') && method === 'GET') {
        return json({ state: 'open', node_id: 'ISSUE_NODE_5' })
      }
      if (u.endsWith('/repos/acme/api/issues/5/comments') && method === 'POST') {
        comentarios.push(JSON.parse(String(init?.body)))
        return json({ id: 1 })
      }
      if (u.endsWith('/repos/acme/api/issues/5') && method === 'PATCH') {
        fechamentos.push(JSON.parse(String(init?.body)))
        return json({})
      }
      if (u.startsWith('https://api.telegram.org/')) {
        return json({ ok: true })
      }
      // Ensaio do ambiente (Tarefa 14) — qualquer endereço/caminho testado
      // responde 200; não é o que este arquivo prova.
      return new Response('ok', { status: 200 })
    }
  ) as unknown as typeof fetch

  return { impl, comentarios, fechamentos, graphqlCalls }
}

function sessaoBase(over: Record<string, unknown> = {}) {
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
    mergeCommitSha: 'deadbeef',
    deployState: null,
    deployCheckedAt: null,
    mergeFailures: 0,
    mergeLastFailedAt: null,
    closedAt: null,
    ...over,
  }
}

describe('resolverEntregaDoBoard (Item 2 — o board só diz "entregue" quando o produto sabe)', () => {
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

  test('publicação com veredito POSITIVO (no-ar): fecha a tarefa e move o card para "done"', async () => {
    const { impl, comentarios, fechamentos, graphqlCalls } = fakeGithubBoard({
      environments: [{ name: 'production' }],
      deployments: [
        {
          id: 1,
          environment: 'production',
          sha: 'deadbeef',
          production_environment: true,
          transient_environment: false,
        },
      ],
      statuses: [
        {
          state: 'success',
          environment_url: 'https://prod.example.com',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    })
    global.fetch = impl

    const prisma = buildFakePrisma(sessaoBase())
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const fechouSessao = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechouSessao).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    const chamadaDeEstado = prisma._updateCalls.find((c) => c.data['deployState'] !== undefined)
    expect(chamadaDeEstado?.data).toMatchObject({ deployState: 'no-ar' })

    // A tarefa fecha como entregue — comenta citando o PR e fecha.
    expect(comentarios).toHaveLength(1)
    expect(comentarios[0]!.body).toContain('#7')
    expect(fechamentos).toHaveLength(1)
    expect(fechamentos[0]!.state).toBe('closed')

    // O card vai para "done" — a mutação do GraphQL carrega o id da opção
    // "Done" do board fake, nunca "In Review".
    const moveu = graphqlCalls.find((c) => c.query.includes('UpdateProjectV2SingleSelectField'))
    expect(moveu?.variables['optionId']).toBe('O_DONE')

    // Crítico 1 (leva C): as DUAS escritas que `ghSend` faz aqui (comentar,
    // fechar) e a chamada de GraphQL que o movedor de card faz (achado
    // adicional da mesma auditoria — `createCardMover` não tinha teto
    // nenhum) agora carregam um `AbortSignal`. Sem isso, uma chamada
    // pendurada em QUALQUER uma das três prenderia `tickEmAndamento` (a
    // trava contra sobreposição de tique) para sempre — a mesma classe de
    // defeito que já tinha sido fechada no lado da LEITURA (`ghGet`, leva
    // B2).
    const chamadasFeitas = (impl as unknown as { mock: { calls: Array<[unknown, unknown]> } }).mock
      .calls
    const chamadaDeComentario = chamadasFeitas.find(
      ([u, i]) => String(u).endsWith('/issues/5/comments') && (i as RequestInit)?.method === 'POST'
    )
    const chamadaDeFechamento = chamadasFeitas.find(
      ([u, i]) => String(u).endsWith('/issues/5') && (i as RequestInit)?.method === 'PATCH'
    )
    const chamadaDeGraphql = chamadasFeitas.find(([u]) => String(u).endsWith('/graphql'))
    for (const chamada of [chamadaDeComentario, chamadaDeFechamento, chamadaDeGraphql]) {
      const init = chamada?.[1] as RequestInit | undefined
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
    }
  })

  test('publicação SEM confirmação dentro do prazo (sem-publicacao por timeout): NÃO fecha a tarefa como entregue — comenta e volta o card para "review"', async () => {
    const { impl, comentarios, fechamentos, graphqlCalls } = fakeGithubBoard({
      // Mecanismo de deployment EXISTE (não é "nenhum") — só que zero
      // publicações para este commit, e a janela de tolerância já se
      // esgotou (`stateCheckedAt`, abaixo, 40min no passado).
      environments: [{ name: 'production' }],
      deployments: [],
    })
    global.fetch = impl

    const prisma = buildFakePrisma(
      sessaoBase({ stateCheckedAt: new Date(Date.now() - 40 * 60_000) })
    )
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const fechouSessao = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechouSessao).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    const chamadaDeEstado = prisma._updateCalls.find((c) => c.data['deployState'] !== undefined)
    expect(chamadaDeEstado?.data).toMatchObject({ deployState: 'sem-publicacao' })

    // A MENTIRA que este item existe para acabar: a tarefa NUNCA fecha como
    // entregue por este caminho.
    expect(fechamentos).toHaveLength(0)
    // Mas o dono vê o PORQUÊ direto na issue — um comentário sai mesmo
    // assim.
    expect(comentarios).toHaveLength(1)
    expect(comentarios[0]!.body).toContain('#7')

    // O card volta para "review" — nunca "done".
    const moveu = graphqlCalls.find((c) => c.query.includes('UpdateProjectV2SingleSelectField'))
    expect(moveu?.variables['optionId']).toBe('O_REVIEW')
  })

  test('repositório PROVADAMENTE não publica (mecanismo "nenhum"): fecha prontamente, sem esperar veredito nenhum', async () => {
    // Nem environments nem workflows — `descobrirMecanismo` conclui
    // `tipo: 'nenhum'` na hora, e `acompanharPublicacao` resolve
    // `sem-publicacao` na PRIMEIRA leitura, sem esperar janela nenhuma.
    const { impl, comentarios, fechamentos, graphqlCalls } = fakeGithubBoard({
      environments: [],
    })
    global.fetch = impl

    // `stateCheckedAt` bem recente — a prova de que "prontamente" não
    // depende de nenhum teto de tempo, ao contrário do caso anterior.
    const prisma = buildFakePrisma(sessaoBase({ stateCheckedAt: new Date() }))
    app = Fastify({ logger: false })
    app.decorate('prisma', prisma as never)
    await app.register(schedulerPlugin)

    await vi.waitFor(
      () => {
        const fechouSessao = prisma._updateCalls.some(
          (c) => c.data['closedAt'] !== undefined && c.data['closedReason'] === 'merged'
        )
        expect(fechouSessao).toBe(true)
      },
      { timeout: 3000, interval: 10 }
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    const chamadaDeEstado = prisma._updateCalls.find((c) => c.data['deployState'] !== undefined)
    expect(chamadaDeEstado?.data).toMatchObject({ deployState: 'sem-publicacao' })

    // O merge JÁ é a entrega quando o repositório não publica — fecha e
    // move para "done", igual ao caso positivo.
    expect(fechamentos).toHaveLength(1)
    expect(fechamentos[0]!.state).toBe('closed')
    expect(comentarios).toHaveLength(1)
    const moveu = graphqlCalls.find((c) => c.query.includes('UpdateProjectV2SingleSelectField'))
    expect(moveu?.variables['optionId']).toBe('O_DONE')
  })
})
