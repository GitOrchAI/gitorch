import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { RuntimeAdapter } from '@gitorch/agents'
import type { AgentQuestionService } from '../services/agent-question.js'
import { encryptCredential } from '../lib/credential-crypto.js'
import { limparFreiosDeCota } from '../services/freio-de-cota-do-github.js'
import { limparCacheDeLeituraDoQuadro } from '../services/leitura-do-quadro-em-cache.js'
import { hashDoCorpoDaTarefa } from '../services/conferir-tarefa-sem-pedido.js'

// As três ligações da Fase 4 pelo caminho REAL do serviço: o plugin do
// scheduler montando os ganchos. As peças existiam, passavam nos próprios
// testes e ninguém as chamava; estes testes falham se um gancho sumir:
//
//  4.1 a varredura do retrato confere as tarefas (gancho `conferirTarefa`);
//  4.2 a missão do PO reescreve a tarefa fora do padrão (aplicador);
//  4.3 o passe do custo da ordem registra a tarefa fora da sprint no painel.
//
// O motor de IA é FALSO (o adaptador do CLI é trocado) e o GitHub é o
// `global.fetch`; o prompt, a validação, as travas e as escritas são o código
// de produção.
const motor = vi.hoisted(() => ({
  prompts: [] as string[],
  responder: (_prompt: string): string => '{}',
}))

vi.mock('@gitorch/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gitorch/agents')>()
  return {
    ...actual,
    createCliRuntimeAdapter: (opcoes: { runtime: RuntimeAdapter['runtime'] }): RuntimeAdapter => ({
      runtime: opcoes.runtime,
      async run(pedido) {
        motor.prompts.push(pedido.prompt)
        return {
          missionId: pedido.missionId,
          runtime: opcoes.runtime,
          exitCode: 0,
          durationMs: 1,
          output: motor.responder(pedido.prompt),
          stderr: '',
        }
      },
    }),
  }
})

const { schedulerPlugin } = await import('./scheduler.js')

const REPO = 'acme/api'
const TOKEN_DO_CLIENTE = 'ghp_token_do_cliente'
const QUADRO_ID = 'PVT_quadro'
const HORA = 3_600_000

function projeto(autonomia: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'proj_1',
    wingId: REPO,
    name: 'Acme API',
    userId: 'user_1',
    runtimeConfig: null,
    devPlan: null,
    autonomia,
    accessSuspendedAt: null,
    accessSuspendedReason: null,
    isActive: true,
    user: null,
    encryptedClientToken: encryptCredential(TOKEN_DO_CLIENTE),
    autonomiaDeSeguranca: 'so_olhar',
    ...extra,
  }
}

const CORPO_SOLTO = 'Texto solto. Veja #1007 e https://exemplo.com/t/7.'
const HASH_SOLTO = hashDoCorpoDaTarefa('Tarefa 7', CORPO_SOLTO)

interface MissaoFalsa {
  id: string
  status: string
  payload: Record<string, unknown>
  error?: string
}

function buildFakePrisma(p: ReturnType<typeof projeto>, opcoes: { candidatas?: boolean } = {}) {
  const missoes: MissaoFalsa[] = []
  const eventos: Array<{ chave: string; texto: string }> = []
  const conferencias: Array<{
    where: Record<string, unknown>
    conferencia: Record<string, unknown>
  }> = []
  const linhaDaTarefa = {
    conferencia: null as Record<string, unknown> | null,
    atualizadoEm: new Date('2026-10-08T00:00:00Z'),
  }
  return {
    _missoes: missoes,
    _eventos: eventos,
    _conferencias: conferencias,
    mission: {
      create: vi.fn(async ({ data }: { data: { payload: Record<string, unknown> } }) => {
        const m: MissaoFalsa = {
          id: `mission_${missoes.length + 1}`,
          status: 'running',
          payload: data.payload,
        }
        missoes.push(m)
        return { id: m.id }
      }),
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { tokensUsed: 0 } })),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const m = missoes.find((x) => x.id === where.id)
        return m ? { payload: m.payload } : null
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const m = missoes.find((x) => x.id === where.id)
          if (m) Object.assign(m, data)
          return {}
        }
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id?: string }; data: Record<string, unknown> }) => {
          const m = missoes.find((x) => x.id === where.id)
          if (m) Object.assign(m, data)
          return { count: m ? 1 : 0 }
        }
      ),
    },
    project: {
      findFirst: vi.fn(async () => p),
      findUnique: vi.fn(async () => p),
      findMany: vi.fn(async (args?: { select?: Record<string, unknown> }) => {
        // A varredura do retrato e o passe do custo da ordem; as demais etapas do tique ficam sem projeto.
        if (
          args?.select &&
          ('encryptedClientToken' in args.select || 'runtimeConfig' in args.select)
        ) {
          return [p]
        }
        return []
      }),
      update: vi.fn(async () => ({})),
    },
    engineConnection: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    devSession: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      update: vi.fn(async () => undefined),
    },
    repoItem: {
      // As conferências já gravadas (varredura) e as candidatas ao ajuste (missão do PO) / fora da sprint (4.3).
      findMany: vi.fn(
        async (args: { where?: Record<string, unknown>; select?: Record<string, boolean> }) => {
          if (opcoes.candidatas && args.select?.['conferencia'] && args.select['numero']) {
            return [
              {
                numero: 7,
                conferencia: {
                  padraoOk: false,
                  erros: ['goal: empty'],
                  camposFaltando: ['goal'],
                  peso: null,
                  estaNoQuadro: true,
                  naSprint: false,
                  emExecucao: false,
                  hashDoCorpo: HASH_SOLTO,
                },
              },
            ]
          }
          if (args.select?.['numero'] && !args.select['conferencia']) return [{ numero: 7 }]
          return []
        }
      ),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () => linhaDaTarefa),
      updateMany: vi.fn(
        async (args: {
          where: Record<string, unknown>
          data: { conferencia: Record<string, unknown> }
        }) => {
          conferencias.push({ where: args.where, conferencia: args.data.conferencia })
          linhaDaTarefa.conferencia = args.data.conferencia
          linhaDaTarefa.atualizadoEm = new Date(linhaDaTarefa.atualizadoEm.getTime() + 1)
          return { count: 1 }
        }
      ),
      upsert: vi.fn(async () => ({})),
    },
    event: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: { payload: { chave?: string; texto?: string } } }) => {
        if (data.payload.chave) {
          eventos.push({ chave: data.payload.chave, texto: data.payload.texto ?? '' })
        }
        return {}
      }),
    },
    agentQuestion: { findFirst: vi.fn(async () => null) },
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
  'GITORCH_TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'GITORCH_AJUSTE_DE_TAREFA',
  'GITORCH_CUSTO_DA_ORDEM_CADENCIA_MS',
]

interface RedeFalsa {
  fetchMock: ReturnType<typeof vi.fn>
  escritas: Array<{ metodo: string; caminho: string; corpo: { title?: string; body?: string } }>
  graphql: string[]
}

function montarRede(config: {
  issuesAbertas?: unknown[]
  issueDaTarefa?: Record<string, unknown>
  itensDoQuadro?: unknown[]
}): RedeFalsa {
  const rede: RedeFalsa = { fetchMock: vi.fn(), escritas: [], graphql: [] }
  const json = (corpo: unknown) =>
    new Response(JSON.stringify(corpo), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  rede.fetchMock = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const endereco = String(url)
    const metodo = (init?.method ?? 'GET').toUpperCase()

    if (endereco === 'https://api.github.com/graphql') {
      const corpo = JSON.parse(String(init?.body ?? '{}')) as { query: string }
      const nome = /(?:query|mutation)\s+(\w+)/.exec(corpo.query)?.[1] ?? '?'
      rede.graphql.push(nome)
      if (nome === 'ListarQuadrosDoRepositorio') {
        return json({
          data: {
            repository: {
              projectsV2: {
                nodes: [
                  {
                    id: QUADRO_ID,
                    number: 2,
                    title: 'Quadro',
                    closed: false,
                    items: { totalCount: 2 },
                    fields: { totalCount: 13 },
                  },
                ],
              },
            },
          },
        })
      }
      if (nome === 'GetProjectId')
        return json({
          data: { repositoryOwner: { __typename: 'Organization', projectV2: { id: QUADRO_ID } } },
        })
      if (nome === 'GetIterationField') {
        return json({
          data: {
            node: {
              fields: {
                nodes: [
                  {
                    __typename: 'ProjectV2IterationField',
                    id: 'F_sprint',
                    name: 'Sprint',
                    configuration: {
                      iterations: [
                        {
                          id: 'IT_hoje',
                          title: 'S1',
                          startDate: new Date(Date.now() - 24 * HORA).toISOString().slice(0, 10),
                          duration: 30,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        })
      }
      if (nome === 'ItensDoQuadro') {
        return json({
          data: {
            node: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: config.itensDoQuadro ?? [],
              },
            },
          },
        })
      }
      return json({ data: {} })
    }

    if (endereco.startsWith('https://api.telegram.org/')) return json({ ok: true })

    const um = /\/repos\/acme\/api\/issues\/(\d+)$/.exec(endereco)
    if (um) {
      if (metodo === 'PATCH') {
        rede.escritas.push({
          metodo,
          caminho: new URL(endereco).pathname,
          corpo: JSON.parse(String(init?.body ?? '{}')) as { title?: string; body?: string },
        })
        return json({})
      }
      return json(config.issueDaTarefa ?? {})
    }
    if (endereco.includes('/repos/acme/api/issues?state=open'))
      return json(config.issuesAbertas ?? [])
    if (endereco.includes('/repos/acme/api/pulls?state=open')) return json([])
    return json([])
  })
  return rede
}

describe('tarefas sem pedido, pelo caminho real do scheduler (real seam)', () => {
  const original: Record<string, string | undefined> = {}
  const originalFetch = global.fetch
  let app: ReturnType<typeof Fastify> | undefined

  beforeEach(() => {
    limparFreiosDeCota()
    limparCacheDeLeituraDoQuadro()
    motor.prompts.length = 0
    motor.responder = () => '{}'
    for (const chave of ENV_KEYS) {
      original[chave] = process.env[chave]
      delete process.env[chave]
    }
    process.env['GITORCH_GITHUB_TOKEN'] = 'token-de-teste'
  })

  afterEach(async () => {
    if (app) await app.close()
    app = undefined
    for (const chave of ENV_KEYS) {
      if (original[chave] === undefined) delete process.env[chave]
      else process.env[chave] = original[chave]
    }
    global.fetch = originalFetch
    limparFreiosDeCota()
    limparCacheDeLeituraDoQuadro()
    vi.restoreAllMocks()
  })

  async function subir(prisma: ReturnType<typeof buildFakePrisma>) {
    app = Fastify({ logger: { level: 'silent' } })
    app.decorate('prisma', prisma as unknown as PrismaClient)
    app.decorate('agentQuestionService', {
      ask: vi.fn(async () => ({ deduped: false })),
    } as unknown as AgentQuestionService)
    await app.register(schedulerPlugin)
    return app
  }

  // ------------------------------------------------------------------ 4.1

  test('4.1: a varredura do retrato confere a tarefa e grava na coluna de conferência, com o quadro lido', async () => {
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '20'
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '3600000'
    const rede = montarRede({
      issuesAbertas: [
        {
          number: 7,
          state: 'open',
          title: 'Tarefa 7',
          body: CORPO_SOLTO,
          labels: [{ name: 'gitorch:task' }],
        },
        {
          number: 8,
          state: 'open',
          title: 'Bug solto',
          body: 'quebrou',
          labels: [{ name: 'bug' }],
        },
      ],
      itensDoQuadro: [
        {
          id: 'item7',
          content: { number: 7, corpo: null },
          fieldValueByName: { iterationId: 'IT_hoje' },
          pesoValue: null,
        },
      ],
    })
    global.fetch = rede.fetchMock as unknown as typeof fetch
    const prisma = buildFakePrisma(projeto('so_olhar'))

    await subir(prisma)

    await vi.waitFor(() => expect(prisma._conferencias.length).toBeGreaterThan(0), {
      timeout: 8000,
      interval: 10,
    })
    const gravada = prisma._conferencias[0]!.conferencia
    expect(gravada).toMatchObject({
      padraoOk: false,
      estaNoQuadro: true,
      naSprint: true,
      hashDoCorpo: HASH_SOLTO,
    })
    expect(prisma._conferencias[0]!.where).toMatchObject({
      projectId: 'proj_1',
      tipo: 'issue',
      numero: 7,
    })
    // o bug solto não foi conferido
    expect(prisma._conferencias.every((c) => c.where['numero'] === 7)).toBe(true)
    expect(prisma._eventos.map((e) => e.chave)).toEqual([
      expect.stringMatching(/^conferencia:acme\/api:7:/),
    ])
    // a conferência não escreve nada no GitHub
    expect(rede.escritas).toEqual([])
  })

  // ------------------------------------------------------------------ 4.2

  const formularioDoMotor = (prompt: string): string => {
    if (!prompt.includes('po-ajustar-tarefa-fora-do-padrao')) return '{}'
    return JSON.stringify({
      fields: {
        titulo: 'Tarefa 7 no padrão',
        goal: 'Objetivo, ver #1007.',
        taskDetails: 'Detalhes: https://exemplo.com/t/7',
        taskDescription: 'Descrição',
        implementationGuide: '1. fazer',
        verificationCriteria: '- o teste passa',
        dependencies: 'nenhuma',
        relatedFiles: 'src/x.ts',
        notes: 'notas',
      },
    })
  }

  async function dispararPo(prisma: ReturnType<typeof buildFakePrisma>) {
    process.env['NODE_ENV'] = 'production'
    // O relógio do tique não pode disputar a missão deste teste.
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '3600000'
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '3600000'
    await subir(prisma)
    const resultado = await app!.triggerAgentMission('po', 'proj_1')
    expect(resultado.triggered).toBe(true)
    const id = resultado.missionId as string
    await vi.waitFor(
      () => {
        const missao = prisma._missoes.find((m) => m.id === id)
        if (missao?.status === 'failed') throw new Error(`missão falhou: ${missao.error}`)
        expect(missao?.status).toBe('completed')
      },
      { timeout: 8000, interval: 20 }
    )
  }

  const issueDaTarefa = () => ({
    number: 7,
    title: 'Tarefa 7',
    body: CORPO_SOLTO,
    state: 'open',
    labels: [{ name: 'gitorch:task' }],
    updated_at: new Date(Date.now() - 72 * HORA).toISOString(),
  })

  test('4.2: na missão do PO, com autonomia "cuidar", a tarefa fora do padrão é reescrita e o original fica guardado', async () => {
    motor.responder = formularioDoMotor
    const rede = montarRede({ issueDaTarefa: issueDaTarefa() })
    global.fetch = rede.fetchMock as unknown as typeof fetch
    const prisma = buildFakePrisma(projeto('cuidar'), { candidatas: true })

    await dispararPo(prisma)

    expect(rede.escritas).toHaveLength(1)
    expect(rede.escritas[0]!.caminho).toBe('/repos/acme/api/issues/7')
    expect(rede.escritas[0]!.corpo.title).toBe('Tarefa 7 no padrão')
    expect(rede.escritas[0]!.corpo.body).toContain('<details><summary>Texto original</summary>')
    expect(rede.escritas[0]!.corpo.body).toContain(CORPO_SOLTO)
    // o original foi para a ficha antes da escrita; o painel tem o rastro
    expect(prisma._conferencias.some((c) => 'original' in c.conferencia)).toBe(true)
    expect(prisma._eventos.some((e) => e.chave === `ajuste:${REPO}:7:${HASH_SOLTO}`)).toBe(true)
  })

  test.each(['so_olhar', 'sugerir'])(
    '4.2: com autonomia "%s" nada é escrito e o motor não é chamado para isso',
    async (autonomia) => {
      motor.responder = formularioDoMotor
      const rede = montarRede({ issueDaTarefa: issueDaTarefa() })
      global.fetch = rede.fetchMock as unknown as typeof fetch
      const prisma = buildFakePrisma(projeto(autonomia), { candidatas: true })

      await dispararPo(prisma)

      expect(rede.escritas).toEqual([])
      expect(motor.prompts.some((p) => p.includes('po-ajustar-tarefa-fora-do-padrao'))).toBe(false)
    }
  )

  test('4.2: interruptor desligado pela variável de ambiente: nada é escrito', async () => {
    process.env['GITORCH_AJUSTE_DE_TAREFA'] = 'off'
    motor.responder = formularioDoMotor
    const rede = montarRede({ issueDaTarefa: issueDaTarefa() })
    global.fetch = rede.fetchMock as unknown as typeof fetch
    const prisma = buildFakePrisma(projeto('cuidar'), { candidatas: true })

    await dispararPo(prisma)

    expect(rede.escritas).toEqual([])
    expect(motor.prompts.some((p) => p.includes('po-ajustar-tarefa-fora-do-padrao'))).toBe(false)
  })

  // ------------------------------------------------------------------ 4.3

  test('4.3: o passe do custo da ordem registra no painel a tarefa fora da sprint, sem escrever nada', async () => {
    process.env['NODE_ENV'] = 'production'
    process.env['GITORCH_SCHEDULER_TICK_MS'] = '20'
    process.env['GITORCH_SCHEDULER_TICK_RAPIDO_MS'] = '3600000'
    process.env['GITORCH_CUSTO_DA_ORDEM_CADENCIA_MS'] = '3600000'
    const marcador = (n: number) => `<!-- gitorch:node:1:task:${n} -->`
    const rede = montarRede({
      itensDoQuadro: [
        {
          id: 'i7',
          content: { number: 7, corpo: marcador(0) },
          fieldValueByName: null,
          pesoValue: { number: 3 },
        },
        {
          id: 'i9',
          content: { number: 9, corpo: marcador(1) },
          fieldValueByName: null,
          pesoValue: { number: 2 },
        },
      ],
    })
    global.fetch = rede.fetchMock as unknown as typeof fetch
    const prisma = buildFakePrisma(
      projeto('cuidar', {
        runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'acme/2' } },
      })
    )

    await subir(prisma)

    await vi.waitFor(
      () =>
        expect(prisma._eventos.some((e) => e.chave.startsWith(`fora-da-sprint:${REPO}:7:`))).toBe(
          true
        ),
      { timeout: 8000, interval: 10 }
    )
    expect(rede.escritas).toEqual([])
    expect(
      rede.graphql.filter(
        (n) =>
          n !== 'ItensDoQuadro' &&
          n !== 'GetIterationField' &&
          n !== 'GetProjectId' &&
          n !== 'ListarQuadrosDoRepositorio'
      )
    ).toEqual([])
  })
})
