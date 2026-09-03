import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { painelRoutes, resolveQuadroDoProjeto } from './painel.js'
import { LeituraIndisponivelError } from '../services/leitura-do-repositorio.js'
import { hojeNoFuso } from '../services/garantir-sprint.js'
import { ArvoreIndisponivelError, PedidoNaoEncontradoError } from '../services/arvore-de-pedidos.js'
import { tabelaEmMemoria, type ConsultaEmMemoria } from '../test/where-em-memoria.js'
import type { SessaoDaEntrega, ProjetoDaEntrega } from '../services/entregas-por-pedido.js'
import type { EntregaDoPainel } from '../services/incremento.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

// Fake Prisma injetado (padrão dos testes do control-plane — nunca banco real).
// resolveOwnerId não toca no Prisma quando a sessão não tem e-mail (JWT de
// teste), então basta cobrir event/mission/agentQuestion.
// O dono 'owner_1' tem 1 projeto por padrão (as rotas resolvem os ids do dono
// antes de consultar Event/Mission por `projectId: { in }`).
function fakePrisma(over: Record<string, any> = {}) {
  return {
    project: {
      findMany: vi.fn().mockResolvedValue([{ id: 'proj_1' }]),
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    event: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    mission: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    agentQuestion: { findUnique: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    // Dono sem motor conectado — o caso mais comum nos testes das outras
    // rotas. Precisa existir: a rota /agentes lê a cota do banco por padrão,
    // e um fake sem esta tabela faria a leitura estourar e a resposta dizer
    // "não consegui ler" quando o certo é "não há motor".
    engineConnection: { findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  }
}

const ultimoEvento = (over: Record<string, any>) => ({
  event: { findFirst: vi.fn().mockResolvedValue(over) },
})

describe('Rotas do painel do owner', () => {
  let app: ReturnType<typeof Fastify>
  let authHeaders: { authorization: string }

  async function build(prisma: any = fakePrisma(), opts: any = {}) {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    ;(app as any).prisma = prisma
    await painelRoutes(app, opts)
    const token = jwt.sign({ userId: 'owner_1', wingId: 'octocat' }, env.JWT_SECRET)
    authHeaders = { authorization: `Bearer ${token}` }
    await app.ready()
    return prisma
  }

  const getPulso = () =>
    app.inject({ method: 'GET', url: '/api/v1/painel/pulso', headers: authHeaders })
  const getAgentes = () =>
    app.inject({ method: 'GET', url: '/api/v1/painel/agentes', headers: authHeaders })
  const getPedidos = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/v1/painel/pedidos${qs}`, headers: authHeaders })
  const getArvore = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/v1/painel/pedidos/arvore${qs}`, headers: authHeaders })
  const getSprint = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/v1/painel/sprint${qs}`, headers: authHeaders })
  const getLeitura = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/v1/painel/leitura${qs}`, headers: authHeaders })
  const getEntregas = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/v1/painel/entregas${qs}`, headers: authHeaders })
  const getRegua = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/v1/painel/regua${qs}`, headers: authHeaders })
  const getCiclo = (qs = '') =>
    app.inject({ method: 'GET', url: `/api/v1/painel/ciclo${qs}`, headers: authHeaders })

  beforeEach(async () => {
    await build()
  })

  describe('GET /api/v1/painel/pulso', () => {
    test('sem sessão → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/pulso' })
      expect(res.statusCode).toBe(401)
    })

    test('sem nenhum sinal → campos nulos e quente:false', async () => {
      const res = await getPulso()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        ultimo_sinal_em: null,
        ha_segundos: null,
        descricao: null,
        quente: false,
        limite_frio_segundos: 3600,
      })
    })

    test('usa o createdAt REAL do evento, não a hora da consulta', async () => {
      const quando = new Date(Date.now() - 120_000) // 2 min atrás
      await build(
        fakePrisma(ultimoEvento({ type: 'mission.completed', payload: {}, createdAt: quando }))
      )

      const body = (await getPulso()).json()
      expect(body.ultimo_sinal_em).toBe(quando.toISOString())
      expect(body.ha_segundos).toBeGreaterThanOrEqual(110)
      expect(body.ha_segundos).toBeLessThan(3600)
      expect(body.quente).toBe(true)
      expect(typeof body.descricao).toBe('string')
      expect(body.descricao.length).toBeGreaterThan(0)
    })

    test('sinal com mais de 1h → quente:false', async () => {
      const antigo = new Date(Date.now() - 4_000_000)
      await build(fakePrisma(ultimoEvento({ type: 'x', payload: {}, createdAt: antigo })))
      expect((await getPulso()).json().quente).toBe(false)
    })

    test('escopo por dono: resolve os projetos do dono e filtra por projectId, nunca wingId', async () => {
      const prisma = await build(
        fakePrisma({
          project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]) },
        })
      )
      await getPulso()
      expect(prisma.project.findMany.mock.calls[0][0].where).toEqual({ userId: 'owner_1' })
      expect(prisma.event.findFirst.mock.calls[0][0].where).toEqual({
        projectId: { in: ['p1', 'p2'] },
      })
      expect(JSON.stringify(prisma.mission.findFirst.mock.calls[0][0].where)).not.toContain(
        'octocat'
      )
    })

    test('dono sem projeto → campos nulos sem tocar Event/Mission', async () => {
      const prisma = await build(
        fakePrisma({ project: { findMany: vi.fn().mockResolvedValue([]) } })
      )
      const body = (await getPulso()).json()
      expect(body.ultimo_sinal_em).toBeNull()
      expect(prisma.event.findFirst).not.toHaveBeenCalled()
    })
  })

  describe('GET /api/v1/painel/agentes', () => {
    const comMissoes = (rows: any[]) => ({
      project: { findMany: vi.fn().mockResolvedValue([{ id: 'proj_1' }]) },
      mission: {
        findMany: vi.fn().mockResolvedValue(rows),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    })

    test('sem sessão → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/agentes' })
      expect(res.statusCode).toBe(401)
    })

    test('dono sem motor nenhum → lista vazia, mas dizendo que LEU', async () => {
      // Este teste já existiu afirmando `{atuando: [], motores: []}` como o
      // certo — e passava verde porque o default da rota devolvia vazio, não
      // porque o produto tivesse lido alguma coisa. Era um teste concordando
      // com o código em vez de com a realidade. Agora ele exige `cotaLida`.
      const res = await getAgentes()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        atuando: [],
        motores: [],
        cotaLida: true,
        motivoDaCota: null,
      })
    })

    test('os motores do banco CHEGAM na resposta (o defeito de 30/08)', async () => {
      // O painel dizia "Nenhum motor conectado ainda." com o banco cheio:
      // `painelRoutes(app)` era registrada sem opts e caía num default que
      // devolvia []. Este teste confere o RESULTADO — se o default voltar a
      // ser vazio, ele reprova.
      await build(
        fakePrisma({
          ...comMissoes([]),
          engineConnection: {
            findMany: vi.fn().mockResolvedValue([
              {
                runtime: 'antigravity',
                status: 'connected',
                sessionPercentUsed: 0,
                weekPercentUsed: 56,
                // As janelas viram NO FUTURO: percentual de janela já vencida é
                // suprimido (vale a mesma regra do assistente). Sem estas duas
                // datas o teste afirmaria que número velho deve aparecer.
                sessionResetsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
                weekResetsAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
                quotaRefreshedAt: new Date('2026-08-30T17:01:29.323Z'),
              },
              {
                runtime: 'codex',
                status: 'needs_reconnect',
                sessionPercentUsed: null,
                sessionResetsAt: null,
                weekPercentUsed: null,
                weekResetsAt: null,
                quotaRefreshedAt: null,
              },
            ]),
          },
        })
      )

      const body = getAgentes ? (await getAgentes()).json() : null
      expect(body.cotaLida).toBe(true)
      expect(body.motores).toHaveLength(2)
      expect(body.motores[0]).toMatchObject({
        id: 'antigravity',
        nome: 'Antigravity',
        estado: 'ligado',
        semana: 56,
        precisaReligar: false,
      })
      // O motor caído aparece DITO — o assistente já mostrou "Conectado" com
      // o motor morto havia uma hora, e quem descobriu foi o dono.
      expect(body.motores[1]).toMatchObject({
        id: 'codex',
        estado: 'precisa_religar',
        precisaReligar: true,
        semana: null,
      })
    })

    test('falha ao ler cota NÃO se disfarça de "nenhum motor"', async () => {
      // Os dois davam a mesma tela vazia. Agora a resposta separa o fato
      // ("você não tem motor") do não-saber ("não consegui ler").
      await build(fakePrisma(comMissoes([])), {
        lerCotas: async () => {
          throw new Error('banco fora do ar')
        },
      })

      const body = (await getAgentes()).json()
      expect(body.motores).toEqual([])
      expect(body.cotaLida).toBe(false)
      expect(body.motivoDaCota).toBeTruthy()
    })

    test('missão running → estado trabalhando e progresso SEMPRE null', async () => {
      const t0 = new Date(Date.now() - 60_000)
      await build(
        fakePrisma(
          comMissoes([
            {
              id: 'm1',
              type: 'agent-run-qa',
              payload: { engine: 'Jules' },
              status: 'running',
              waitingStatus: null,
              startedAt: t0,
              createdAt: t0,
              project: { name: 'Checkout' },
            },
          ])
        )
      )
      const [a] = (await getAgentes()).json().atuando
      expect(a.estado).toBe('trabalhando')
      expect(a.progresso).toBeNull()
      expect(a.nome).toBe('Jules')
      expect(a.papel).toBe('Qualidade')
      expect(a.projeto).toBe('Checkout')
      expect(a.desde).toBe(t0.toISOString())
    })

    test('missão com waitingStatus → esperando_voce', async () => {
      const t0 = new Date()
      await build(
        fakePrisma(
          comMissoes([
            {
              id: 'm2',
              type: 'agent-run-ra',
              payload: {},
              status: 'running',
              waitingStatus: 'awaiting_user',
              startedAt: t0,
              createdAt: t0,
              project: { name: 'Checkout' },
            },
          ])
        )
      )
      expect((await getAgentes()).json().atuando[0].estado).toBe('esperando_voce')
    })

    test('lerCotas que rejeita → motores:[] (nunca 500)', async () => {
      await build(fakePrisma(), {
        lerCotas: vi.fn().mockRejectedValue(new Error('sem store de cota')),
      })
      const res = await getAgentes()
      expect(res.statusCode).toBe(200)
      expect(res.json().motores).toEqual([])
    })

    test('lerCotas que responde → motores repassados', async () => {
      const motores = [
        {
          id: 'jules',
          nome: 'Jules',
          usado: 14,
          limite: 20,
          janela: '24h',
          limite_conhecido: true,
        },
      ]
      await build(fakePrisma(), { lerCotas: vi.fn().mockResolvedValue(motores) })
      expect((await getAgentes()).json().motores).toEqual(motores)
    })

    test('escopo por dono: findMany filtra projectId dos projetos do dono + status running/pending', async () => {
      const prisma = await build(
        fakePrisma({
          project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
          mission: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
        })
      )
      await getAgentes()
      const where = prisma.mission.findMany.mock.calls[0][0].where
      expect(where.projectId).toEqual({ in: ['p1'] })
      expect(where.status).toEqual({ in: ['running', 'pending'] })
    })
  })

  describe('GET /api/v1/painel/dev-cota — visibilidade da cota do Jules (pedido do dono, 01/09)', () => {
    const getDevCota = () =>
      app.inject({ method: 'GET', url: '/api/v1/painel/dev-cota', headers: authHeaders })

    test('sem sessão → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/dev-cota' })
      expect(res.statusCode).toBe(401)
    })

    test('dono sem projeto → lista de contas vazia, sem tocar devSession', async () => {
      const prisma = await build(
        fakePrisma({
          project: { findMany: vi.fn().mockResolvedValue([]) },
        })
      )
      const res = await getDevCota()
      expect(res.statusCode).toBe(200)
      expect(res.json().contas).toEqual([])
      expect(prisma.devSession).toBeUndefined()
    })

    test('devolve quantas foram enviadas nas últimas 24h, quando, e as vagas restantes pela janela rolante', async () => {
      const agora = Date.now()
      const dentroDaJanela = new Date(agora - 60 * 60 * 1000) // 1h atrás
      const foraDaJanela = new Date(agora - 25 * 60 * 60 * 1000) // 25h atrás

      const prisma = await build(
        fakePrisma({
          project: {
            findMany: vi
              .fn()
              .mockResolvedValue([
                { id: 'proj_1', name: 'GitOrchAI/gitorch', devPlan: 'pro', devAccountId: null },
              ]),
          },
          devSession: {
            findMany: vi.fn().mockResolvedValue([
              {
                projectId: 'proj_1',
                devAccountId: null,
                issueNumber: 309,
                sessionName: 'sessions/1',
                state: 'IN_PROGRESS',
                createdAt: dentroDaJanela,
                closedAt: null,
              },
              {
                projectId: 'proj_1',
                devAccountId: null,
                issueNumber: 100,
                sessionName: 'sessions/2',
                state: 'COMPLETED',
                createdAt: foraDaJanela,
                closedAt: foraDaJanela,
              },
            ]),
          },
        })
      )

      const res = await getDevCota()
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.contas).toHaveLength(1)
      const conta = body.contas[0]
      expect(conta.contaId).toBeNull()
      expect(conta.tetoConcorrentes).toBe(15)
      expect(conta.tetoDiario).toBe(100)
      expect(conta.enviadas24h).toBe(1)
      expect(conta.vagasDiariasRestantes).toBe(99)
      expect(conta.simultaneas).toBe(1)
      expect(conta.vagasRestantes).toBe(14)
      expect(conta.sessoes24h).toEqual([
        {
          projeto: 'GitOrchAI/gitorch',
          issueNumber: 309,
          sessionName: 'sessions/1',
          estado: 'IN_PROGRESS',
          enviadaEm: dentroDaJanela.toISOString(),
          ocupaVaga: true,
        },
      ])

      // A busca no banco pede TANTO quem ainda ocupa vaga (closedAt nulo,
      // pode ter nascido há mais de 24h) QUANTO quem foi criada na janela —
      // nunca só um dos dois, senão a conta perde sessão antiga ainda viva ou
      // sessão recente já fechada.
      const where = prisma.devSession.findMany.mock.calls[0][0].where
      expect(where.OR).toEqual(
        expect.arrayContaining([
          { closedAt: null },
          expect.objectContaining({
            createdAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        ])
      )
    })

    test('escopo por dono: filtra devSession pelos projectId do dono, nunca do dono inteiro sem filtro', async () => {
      const prisma = await build(
        fakePrisma({
          project: {
            findMany: vi
              .fn()
              .mockResolvedValue([{ id: 'p1', name: 'a/b', devPlan: 'pro', devAccountId: null }]),
          },
          devSession: { findMany: vi.fn().mockResolvedValue([]) },
        })
      )
      await getDevCota()
      const where = prisma.devSession.findMany.mock.calls[0][0].where
      expect(where.projectId).toEqual({ in: ['p1'] })
    })
  })

  describe('GET /api/v1/painel/pedidos', () => {
    const umPedido = {
      numero: 30,
      titulo: 'Conseguir solicitar wishlist via telegram',
      situacao: 'andando' as const,
      projeto: 'gitorch',
      quando: '2026-08-06T12:00:00Z',
      endereco: 'https://github.com/GitOrchAI/gitorch/issues/30',
      partes: { total: 3, concluidas: 1 },
    }

    test('sem sessão → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/pedidos' })
      expect(res.statusCode).toBe(401)
    })

    test('devolve os pedidos com a árvore', async () => {
      await build(fakePrisma(), { lerPedidos: async () => [umPedido] })
      const res = await getPedidos()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ pedidos: [umPedido] })
    })

    test('sem pedido nenhum → lista vazia, não erro', async () => {
      await build(fakePrisma(), { lerPedidos: async () => [] })
      const res = await getPedidos()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ pedidos: [] })
    })

    test('?projeto= chega ao serviço', async () => {
      const vistos: Array<{ ownerId: string; projeto?: string }> = []
      await build(fakePrisma(), {
        lerPedidos: async (args: { ownerId: string; projeto?: string }) => {
          vistos.push(args)
          return []
        },
      })
      await getPedidos('?projeto=patinhas')
      expect(vistos[0]?.projeto).toBe('patinhas')
    })

    test('projeto vazio na querystring vira "todos", não filtro por string vazia', async () => {
      const vistos: Array<{ projeto?: string }> = []
      await build(fakePrisma(), {
        lerPedidos: async (args: { ownerId: string; projeto?: string }) => {
          vistos.push(args)
          return []
        },
      })
      await getPedidos('?projeto=%20%20')
      expect(vistos[0]?.projeto).toBeUndefined()
    })

    test('árvore indisponível → 503, e NUNCA lista vazia (não mentir que não há pedido)', async () => {
      await build(fakePrisma(), {
        lerPedidos: async () => {
          throw new ArvoreIndisponivelError('nenhum projeto respondeu')
        },
      })
      const res = await getPedidos()
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ error: 'PEDIDOS_INDISPONIVEIS' })
    })

    test('erro inesperado não vira 503 disfarçado', async () => {
      await build(fakePrisma(), {
        lerPedidos: async () => {
          throw new Error('bug de verdade')
        },
      })
      const res = await getPedidos()
      expect(res.statusCode).toBe(500)
    })

    test('a resposta não carrega id de projeto nem de usuário', async () => {
      await build(fakePrisma(), { lerPedidos: async () => [umPedido] })
      const corpo = (await getPedidos()).body
      expect(corpo).not.toContain('proj_1')
      expect(corpo).not.toContain('owner_1')
    })
  })

  describe('GET /api/v1/painel/pedidos/arvore — fase→épico→feature→task de UM pedido', () => {
    const umNo = {
      numero: 31,
      titulo: 'Fase 1',
      situacao: 'andando' as const,
      endereco: 'https://github.com/GitOrchAI/gitorch/issues/31',
      partes: { total: 0, concluidas: 0 },
      filhos: [],
    }

    test('sem sessão → 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/painel/pedidos/arvore?projeto=gitorch&numero=30',
      })
      expect(res.statusCode).toBe(401)
    })

    test('sem projeto → 400', async () => {
      await build(fakePrisma(), { lerArvoreDoPedido: async () => [umNo] })
      const res = await getArvore('?numero=30')
      expect(res.statusCode).toBe(400)
    })

    test('sem número, ou número que não é inteiro → 400', async () => {
      await build(fakePrisma(), { lerArvoreDoPedido: async () => [umNo] })
      expect((await getArvore('?projeto=gitorch')).statusCode).toBe(400)
      expect((await getArvore('?projeto=gitorch&numero=abc')).statusCode).toBe(400)
      expect((await getArvore('?projeto=gitorch&numero=1.5')).statusCode).toBe(400)
    })

    test('devolve os nós da árvore', async () => {
      await build(fakePrisma(), { lerArvoreDoPedido: async () => [umNo] })
      const res = await getArvore('?projeto=gitorch&numero=30')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ nos: [umNo] })
    })

    test('projeto e número chegam ao serviço', async () => {
      const vistos: Array<{ ownerId: string; projeto: string; numero: number }> = []
      await build(fakePrisma(), {
        lerArvoreDoPedido: async (args: { ownerId: string; projeto: string; numero: number }) => {
          vistos.push(args)
          return []
        },
      })
      await getArvore('?projeto=gitorch&numero=30')
      expect(vistos[0]).toMatchObject({ projeto: 'gitorch', numero: 30 })
    })

    test('pedido não encontrado → 404, nunca 503 (não é "não consegui ler")', async () => {
      await build(fakePrisma(), {
        lerArvoreDoPedido: async () => {
          throw new PedidoNaoEncontradoError('pedido não encontrado no repositório')
        },
      })
      const res = await getArvore('?projeto=gitorch&numero=999')
      expect(res.statusCode).toBe(404)
    })

    test('árvore indisponível → 503', async () => {
      await build(fakePrisma(), {
        lerArvoreDoPedido: async () => {
          throw new ArvoreIndisponivelError('sem credencial do dono')
        },
      })
      const res = await getArvore('?projeto=gitorch&numero=30')
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ error: 'ARVORE_INDISPONIVEL' })
    })

    test('erro inesperado não vira 404 nem 503 disfarçado', async () => {
      await build(fakePrisma(), {
        lerArvoreDoPedido: async () => {
          throw new Error('bug de verdade')
        },
      })
      const res = await getArvore('?projeto=gitorch&numero=30')
      expect(res.statusCode).toBe(500)
    })
  })

  describe('GET /api/v1/painel/entregas — o que ficou pronto, e o que falta', () => {
    // Os estados são os que `dev_sessions` grava de verdade: deployState é
    // 'no-ar' | 'falhou' | 'publicando' | 'sem-publicacao' | 'commit-errado'.
    const PROJETOS: ProjetoDaEntrega[] = [{ id: 'p1', name: 'gitorch', reguaDePronto: null }]

    // Interseção com `Record<string, unknown>` porque `tabelaEmMemoria` filtra
    // lendo campos por nome, como o Prisma faz. O tipo continua o da rota —
    // trocar uma coluna de nome quebra aqui, que é o ponto.
    type SessaoNoBanco = SessaoDaEntrega & Record<string, unknown>

    // Cada linha nasce com `id`, como no banco. A rota ordena por
    // `[updatedAt desc, id desc]` e um fixture sem `id` deixaria o desempate —
    // que é justamente o conserto da ordenação instável — sem ser conferido.
    let proximoId = 0
    const sessao = (over: Partial<SessaoNoBanco> = {}): SessaoNoBanco => ({
      id: `sess_${String(proximoId++).padStart(4, '0')}`,
      projectId: 'p1',
      issueNumber: 42,
      pullRequestNumber: 7,
      mergeCommitSha: 'deadbeef',
      deployState: 'no-ar',
      envLastVerdict: 'no-ar',
      updatedAt: new Date('2026-08-29T23:00:00Z'),
      ...over,
    })

    // O Prisma falso FILTRA, ORDENA e PAGINA de verdade, lendo o mesmo objeto
    // que a rota manda para o Prisma real. Um falso que devolvesse a lista
    // pronta provaria que a rota CHAMOU o banco — e foi um falso desses que
    // deixou o `take: 50` passar por revisão com todos os testes verdes.
    const prismaCom = (
      projetos: readonly ProjetoDaEntrega[],
      sessoes: readonly SessaoNoBanco[]
    ) => {
      const tabela = tabelaEmMemoria(sessoes)
      return fakePrisma({
        project: { findMany: vi.fn().mockResolvedValue(projetos) },
        devSession: { findMany: vi.fn((q: ConsultaEmMemoria) => tabela.findMany(q)) },
      })
    }

    // --- O banco do dono, na forma exata medida em 31/08/2026 --------------
    //
    //   select count(*), count(distinct issue_number) from dev_sessions;
    //     200 | 99
    //   -- 15 pedidos passam na régua padrão, e as sessões deles ocupam as
    //   -- posições 66 a 193 na ordem por `updated_at` desc.
    //
    // A rota trazia as 50 mais recentes: NENHUMA das prontas cabia ali, e a
    // tela dizia "PRONTAS: 0" com quinze entregas no ar.
    const PRONTAS_ANTIGAS: SessaoNoBanco[] = Array.from({ length: 15 }, (_, i) =>
      sessao({
        issueNumber: 100 + i,
        pullRequestNumber: 2000 + i,
        updatedAt: new Date(Date.UTC(2026, 0, 1 + i, 12)),
      })
    )
    // 84 pedidos abertos, com mais de uma sessão cada — é daqui que vêm as 200
    // sessões para 99 pedidos, e é daqui que vinha a `key` repetida na tela.
    const ABERTAS_RECENTES: SessaoNoBanco[] = Array.from({ length: 84 }, (_, p) =>
      Array.from({ length: p < 17 ? 3 : 2 }, (_, t) =>
        sessao({
          issueNumber: 500 + p,
          pullRequestNumber: null,
          mergeCommitSha: null,
          deployState: 'sem-publicacao',
          updatedAt: new Date(Date.UTC(2026, 7, 30, 12) - (p * 3 + t) * 60_000),
        })
      )
    ).flat()
    const BANCO_DO_DONO = [...PRONTAS_ANTIGAS, ...ABERTAS_RECENTES]

    test('o cenário é o do banco medido: 200 sessões para 99 pedidos', () => {
      expect(BANCO_DO_DONO).toHaveLength(200)
      expect(new Set(BANCO_DO_DONO.map((s) => s.issueNumber)).size).toBe(99)
    })

    test('sem sessão, 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/entregas' })
      expect(res.statusCode).toBe(401)
    })

    test('entrega completa aparece como pronta, com a data', async () => {
      await build(prismaCom(PROJETOS, [sessao()]))
      const corpo = (await getEntregas()).json()
      expect(corpo.prontas).toBe(1)
      expect(corpo.entregas[0]).toMatchObject({
        projeto: 'gitorch',
        pedido: 42,
        entrega: 7,
        pronto: true,
        prontoEm: '2026-08-29T23:00:00.000Z',
        porQueNaoFechou: [],
      })
    })

    test('mesclada mas não no ar: NÃO conta como pronta e diz por quê', async () => {
      await build(prismaCom(PROJETOS, [sessao({ deployState: 'sem-publicacao' })]))
      const corpo = (await getEntregas('?grupo=andando')).json()
      expect(corpo.prontas).toBe(0)
      expect(corpo.andando).toBe(1)
      expect(corpo.entregas[0].pronto).toBe(false)
      expect(corpo.entregas[0].porQueNaoFechou).toEqual([
        'foi mesclada, mas ainda não chegou ao ar',
      ])
    })

    test('entrega que não fechou tem data NULA — não usa a última mexida', async () => {
      // Mostrar `updatedAt` como se fosse a data da entrega diria que ficou
      // pronto num dia em que não ficou.
      await build(prismaCom(PROJETOS, [sessao({ deployState: 'falhou' })]))
      const corpo = (await getEntregas('?grupo=andando')).json()
      expect(corpo.entregas[0].prontoEm).toBeNull()
    })

    test('a régua do projeto muda o resultado da MESMA entrega', async () => {
      const semAr = [sessao({ deployState: 'sem-publicacao' })]
      await build(
        prismaCom([{ id: 'p1', name: 'gitorch', reguaDePronto: { no_ar: false } }], semAr)
      )
      const corpo = (await getEntregas()).json()
      expect(corpo.prontas).toBe(1)
    })

    test('dono sem projeto: lista vazia e 200, não erro', async () => {
      await build(prismaCom([], []))
      const res = await getEntregas()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({
        entregas: [],
        prontas: 0,
        andando: 0,
        total: 0,
        grupo: 'prontas',
        pagina: 1,
        porPagina: 25,
        paginas: 0,
      })
    })

    // --- O teto que escondia as entregas ----------------------------------

    test('as 15 prontas aparecem, mesmo sendo as MAIS ANTIGAS do banco', async () => {
      // A prova direta contra o `take: 50`: as prontas são de janeiro e há 185
      // sessões mais recentes que elas.
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas()).json()
      expect(corpo.prontas).toBe(15)
      expect(corpo.entregas).toHaveLength(15)
      expect(corpo.entregas.every((e: EntregaDoPainel) => e.pronto)).toBe(true)
    })

    // --- O denominador é da unidade do CARTÃO ------------------------------

    test('o denominador conta PEDIDOS, não sessões: 99, nunca 200', async () => {
      // O cartão diz "Pedido #N". Dizer "de 200 que passaram pela sua régua"
      // fazia o dono ler duzentos pedidos onde há noventa e nove.
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas()).json()
      expect(corpo.total).toBe(99)
      expect(corpo.prontas + corpo.andando).toBe(corpo.total)
    })

    test('um pedido com três sessões é UM cartão', async () => {
      await build(
        prismaCom(PROJETOS, [
          sessao({ updatedAt: new Date('2026-08-01T00:00:00Z') }),
          sessao({ updatedAt: new Date('2026-08-02T00:00:00Z') }),
          sessao({ updatedAt: new Date('2026-08-03T00:00:00Z') }),
        ])
      )
      const corpo = (await getEntregas()).json()
      expect(corpo.total).toBe(1)
      expect(corpo.entregas).toHaveLength(1)
    })

    test('nenhum pedido se repete na página — a invariante da key do cartão', async () => {
      // Era a `key` repetida que deixava nó de DOM órfão na tela: 25 linhas da
      // API viravam 33 cartões desenhados ao virar a página.
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas('?grupo=andando')).json()
      const chaves = corpo.entregas.map((e: EntregaDoPainel) => `${e.projeto}#${e.pedido}`)
      expect(new Set(chaves).size).toBe(chaves.length)
    })

    // --- A LISTA casa com o NÚMERO ----------------------------------------

    test('sem pedir grupo, a lista traz as PRONTAS — o que o cabeçalho anuncia', async () => {
      // O defeito de leitura: o cabeçalho dizia "Prontas: 15" e a lista mostrava
      // as 50 mais recentes, onde há ZERO prontas. O dono lia 15 e não via
      // nenhuma.
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas()).json()
      expect(corpo.grupo).toBe('prontas')
      expect(corpo.entregas.filter((e: EntregaDoPainel) => e.pronto)).toHaveLength(
        corpo.entregas.length
      )
      expect(corpo.entregas).toHaveLength(corpo.prontas)
    })

    test('as prontas saem da mais recente para a mais antiga', async () => {
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const datas = (await getEntregas())
        .json()
        .entregas.map((e: EntregaDoPainel) => Date.parse(e.prontoEm ?? ''))
      expect(datas).toEqual([...datas].sort((a: number, b: number) => b - a))
    })

    test('o grupo "andando" traz os 84 que não fecharam, e nenhum pronto', async () => {
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas('?grupo=andando')).json()
      expect(corpo.andando).toBe(84)
      expect(corpo.entregas.some((e: EntregaDoPainel) => e.pronto)).toBe(false)
    })

    test('grupo desconhecido cai nas prontas, não em lista vazia', async () => {
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas('?grupo=sei-la')).json()
      expect(corpo.grupo).toBe('prontas')
      expect(corpo.entregas).toHaveLength(15)
    })

    // --- Paginação: igualdade, nunca "no máximo" ---------------------------

    test('a página tem EXATAMENTE 25 linhas, e o cabeçalho fala das 84', async () => {
      // `toBeLessThanOrEqual(25)` passaria com 25, com 1 e com 0. Não prova nada.
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas('?grupo=andando')).json()
      expect(corpo.entregas).toHaveLength(25)
      expect(corpo.porPagina).toBe(25)
      expect(corpo.paginas).toBe(4)
      expect(corpo.andando).toBe(84)
    })

    test('a última página traz EXATAMENTE o que sobrou', async () => {
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas('?grupo=andando&pagina=4')).json()
      expect(corpo.entregas).toHaveLength(9)
      expect(corpo.pagina).toBe(4)
    })

    test('somando TODAS as páginas dá exatamente o número do cabeçalho', async () => {
      // A prova contra a divergência que criou este defeito: a lista inteira e
      // o número têm que falar da mesma população.
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const primeira = (await getEntregas('?grupo=andando')).json()
      const vistos = new Set<string>()
      for (let p = 1; p <= primeira.paginas; p++) {
        const pagina = (await getEntregas(`?grupo=andando&pagina=${p}`)).json()
        for (const e of pagina.entregas) vistos.add(`${e.projeto}#${e.pedido}`)
      }
      expect(vistos.size).toBe(84)
      expect(vistos.size).toBe(primeira.andando)
    })

    test('página além do fim: lista vazia, mas os números continuam certos', async () => {
      // Sem isto, quem navega até o fim veria "0" e concluiria que não há
      // entrega nenhuma — a mesma mentira do teto, na outra ponta.
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas('?grupo=andando&pagina=9')).json()
      expect(corpo.entregas).toEqual([])
      expect(corpo.total).toBe(99)
      expect(corpo.prontas).toBe(15)
      expect(corpo.andando).toBe(84)
    })

    test('porPagina tem teto — pedir 5000 não devolve o banco inteiro', async () => {
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas('?grupo=andando&porPagina=5000')).json()
      expect(corpo.porPagina).toBe(100)
      expect(corpo.entregas).toHaveLength(84)
    })

    test('pagina e porPagina inválidos caem no padrão, não em NaN', async () => {
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      const corpo = (await getEntregas('?grupo=andando&pagina=-3&porPagina=abc')).json()
      expect(corpo.pagina).toBe(1)
      expect(corpo.porPagina).toBe(25)
      expect(corpo.entregas).toHaveLength(25)
    })

    test('a consulta ordena com desempate por id — nunca só por updatedAt', async () => {
      // `updatedAt` é reescrito pela esteira o tempo todo. Ordenar só por ele
      // deixa linhas empatadas trocando de lugar entre uma leitura e a
      // seguinte, e a mesma linha aparece em duas páginas.
      const prisma = await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      await getEntregas()
      expect(prisma.devSession.findMany.mock.calls[0][0].orderBy).toEqual([
        { updatedAt: 'desc' },
        { id: 'desc' },
      ])
    })

    test('a consulta NÃO leva take — o teto vive na página, não na população', async () => {
      const prisma = await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      await getEntregas()
      expect(prisma.devSession.findMany.mock.calls[0][0].take).toBeUndefined()
    })

    test('cada projeto é julgado pela SUA régua, na mesma resposta', async () => {
      const projetos: ProjetoDaEntrega[] = [
        { id: 'p1', name: 'gitorch', reguaDePronto: null },
        { id: 'p2', name: 'patinhas', reguaDePronto: { no_ar: false } },
      ]
      const sessoes = [
        sessao({ projectId: 'p1', issueNumber: 1, deployState: 'sem-publicacao' }),
        sessao({ projectId: 'p2', issueNumber: 2, deployState: 'sem-publicacao' }),
      ]
      await build(prismaCom(projetos, sessoes))
      const corpo = (await getEntregas()).json()
      expect(corpo.total).toBe(2)
      expect(corpo.prontas).toBe(1)
      expect(corpo.entregas.map((e: EntregaDoPainel) => e.pedido)).toEqual([2])
    })

    test('a resposta não carrega id de projeto', async () => {
      await build(prismaCom(PROJETOS, BANCO_DO_DONO))
      expect((await getEntregas()).body).not.toContain('p1')
    })
  })

  describe('GET /api/v1/painel/ciclo — o retrabalho medido, não estimado', () => {
    const sessaoDoCiclo = (over: Record<string, unknown> = {}) => ({
      attempts: 1,
      nudges: 0,
      requeueCount: 0,
      mergeFailures: 0,
      createdAt: new Date('2026-08-29T00:00:00Z'),
      closedAt: new Date('2026-08-29T02:00:00Z'),
      ...over,
    })

    test('sem sessão, 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/ciclo' })
      expect(res.statusCode).toBe(401)
    })

    test('mediana e p90 vêm separados — a média sozinha esconde a cauda', async () => {
      // Nove entregas com 1 cutucada e uma com 40: a média daria 4,9, um
      // número que não descreve nem o típico nem o pior.
      const muitas = [
        ...Array.from({ length: 9 }, () => sessaoDoCiclo({ nudges: 1 })),
        sessaoDoCiclo({ nudges: 40 }),
      ]
      await build(
        fakePrisma({
          project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
          devSession: { findMany: vi.fn().mockResolvedValue(muitas) },
        })
      )
      const c = (await getCiclo()).json()
      expect(c.cutucadas.mediana).toBe(1)
      expect(c.cutucadas.maximo).toBe(40)
      expect(c.entregas).toBe(10)
    })

    test('conta quantas saíram de primeira, sem ninguém empurrar', async () => {
      await build(
        fakePrisma({
          project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
          devSession: {
            findMany: vi.fn().mockResolvedValue([sessaoDoCiclo(), sessaoDoCiclo({ nudges: 2 })]),
          },
        })
      )
      const c = (await getCiclo()).json()
      expect(c.dePrimeira).toBe(1)
    })

    test('o que NÃO dá para medir vem escrito, com o motivo', async () => {
      await build(
        fakePrisma({
          project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
          devSession: { findMany: vi.fn().mockResolvedValue([sessaoDoCiclo()]) },
        })
      )
      const c = (await getCiclo()).json()
      expect(c.naoMedido.length).toBeGreaterThan(0)
      expect(c.naoMedido.join(' ')).toContain('QA reprovou')
    })

    test('dono sem projeto devolve medição vazia, não erro', async () => {
      await build(fakePrisma({ project: { findMany: vi.fn().mockResolvedValue([]) } }))
      const res = await getCiclo()
      expect(res.statusCode).toBe(200)
      expect(res.json().entregas).toBe(0)
      expect(res.json().horasAteFechar).toBeNull()
    })

    // D4 — o multiplicador de velocidade: o ciclo do ITEM (Increment,
    // wishCreatedAt→prontoEm — o desejo até a entrega), não o da sessão do
    // dev. `horasAteFechar` (acima) mede a sessão; isto mede o item inteiro.
    describe('multiplicador — o ciclo do ITEM, cruzado com o retrabalho da sessão que mesclou', () => {
      test('increments não mockado (rota antiga, sem D3 ainda): o resto da medição não quebra', async () => {
        await build(
          fakePrisma({
            project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
            devSession: { findMany: vi.fn().mockResolvedValue([sessaoDoCiclo()]) },
          })
        )
        const res = await getCiclo()
        expect(res.statusCode).toBe(200)
        expect(res.json().entregas).toBe(1)
        expect(res.json().multiplicador.custoDoRetrabalho).toBeNull()
      })

      test('sem nenhum Incremento: os três campos do multiplicador vêm nulos', async () => {
        await build(
          fakePrisma({
            project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
            devSession: { findMany: vi.fn().mockResolvedValue([]) },
            increment: { findMany: vi.fn().mockResolvedValue([]) },
          })
        )
        const c = (await getCiclo()).json()
        expect(c.multiplicador.cicloDePrimeira).toBeNull()
        expect(c.multiplicador.cicloComRetrabalho).toBeNull()
        expect(c.multiplicador.custoDoRetrabalho).toBeNull()
        expect(c.multiplicador.amostra).toEqual({ entregas: 0, dePrimeira: 0, comRetrabalho: 0 })
      })

      test('cruza increments com a sessão MESCLADA da mesma issue para saber quem teve retrabalho', async () => {
        const incrementos = [
          {
            projectId: 'p1',
            issueNumber: 10,
            wishCreatedAt: new Date('2026-08-20T00:00:00Z'),
            prontoEm: new Date('2026-08-20T10:00:00Z'), // 10h, de primeira
          },
          {
            projectId: 'p1',
            issueNumber: 11,
            wishCreatedAt: new Date('2026-08-20T00:00:00Z'),
            prontoEm: new Date('2026-08-21T16:00:00Z'), // 40h, com retrabalho
          },
        ]
        const sessoesMescladas = [
          { projectId: 'p1', issueNumber: 10, requeueCount: 0 },
          { projectId: 'p1', issueNumber: 11, requeueCount: 2 },
        ]
        await build(
          fakePrisma({
            project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
            devSession: {
              findMany: vi.fn(async (args: { where?: { closedReason?: unknown } }) =>
                args?.where?.closedReason ? sessoesMescladas : [sessaoDoCiclo()]
              ),
            },
            increment: { findMany: vi.fn().mockResolvedValue(incrementos) },
          })
        )
        const c = (await getCiclo()).json()
        expect(c.multiplicador.cicloDePrimeira.mediana).toBe(10)
        expect(c.multiplicador.cicloComRetrabalho.mediana).toBe(40)
        expect(c.multiplicador.custoDoRetrabalho).toBe(4)
        expect(c.multiplicador.amostra).toEqual({ entregas: 2, dePrimeira: 1, comRetrabalho: 1 })
      })

      test('increment.findMany explode: o multiplicador some pros nulos, mas o resto da rota responde 200', async () => {
        await build(
          fakePrisma({
            project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
            devSession: { findMany: vi.fn().mockResolvedValue([sessaoDoCiclo()]) },
            increment: { findMany: vi.fn().mockRejectedValue(new Error('banco fora')) },
          })
        )
        const res = await getCiclo()
        expect(res.statusCode).toBe(200)
        expect(res.json().entregas).toBe(1)
        expect(res.json().multiplicador.custoDoRetrabalho).toBeNull()
      })
    })
  })

  describe('POST /api/v1/painel/ordem — a primeira rota que ESCREVE no cliente', () => {
    const PROJETO_COM_QUADRO = {
      id: 'p1',
      wingId: 'dono/repo',
      autonomia: 'cuidar',
      // O formato REAL que o produto guarda: "dono/número", o mesmo que
      // `resolveRailsBoard` lê no scheduler.
      runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'GitOrchAI/2' } },
    }
    // O painel manda NÚMEROS de pedido, nunca ids internos do quadro.
    const PEDIDOS = [36, 37]

    const postOrdem = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/api/v1/painel/ordem', headers: authHeaders, payload })

    test('sem sessão, 401', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/painel/ordem', payload: {} })
      expect(res.statusCode).toBe(401)
    })

    test('sem projeto ou sem pedidos, 400 com a frase certa', async () => {
      await build(fakePrisma())
      expect((await postOrdem({ pedidos: PEDIDOS })).statusCode).toBe(400)
      expect((await postOrdem({ projeto: 'gitorch', pedidos: [] })).statusCode).toBe(400)
    })

    test('o que não for número de pedido é DESCARTADO, e sobrando nada vira 400', async () => {
      // Aceitar e ignorar em silêncio faria o cliente achar que a ordem
      // inteira foi aplicada.
      await build(fakePrisma())
      const res = await postOrdem({ projeto: 'gitorch', pedidos: ['36', null, 1.5] })
      expect(res.statusCode).toBe(400)
    })

    test('projeto de OUTRO dono devolve a mesma frase de inexistente', async () => {
      await build(fakePrisma({ project: { findFirst: vi.fn().mockResolvedValue(null) } }))
      const res = await postOrdem({ projeto: 'de-outro', pedidos: PEDIDOS })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Projeto não encontrado.' })
    })

    test('projeto SEM quadro: 409, e a frase diz que é um passo que falta', async () => {
      await build(
        fakePrisma({
          project: {
            findFirst: vi.fn().mockResolvedValue({ ...PROJETO_COM_QUADRO, runtimeConfig: null }),
          },
        })
      )
      const res = await postOrdem({ projeto: 'gitorch', pedidos: PEDIDOS })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toContain('ainda não tem quadro')
    })

    test('no nível "só olhar" a escrita é RECUSADA com o motivo', async () => {
      // 403, não 500: a recusa não é erro do produto, é a escolha do cliente
      // valendo — e a tela precisa do motivo para dizer o que fazer.
      await build(
        fakePrisma({
          project: {
            findFirst: vi.fn().mockResolvedValue({ ...PROJETO_COM_QUADRO, autonomia: 'so_olhar' }),
          },
        })
      )
      const res = await postOrdem({ projeto: 'gitorch', pedidos: PEDIDOS })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toContain('mude para')
    })
  })

  describe('POST /ordem quando o quadro é GRANDE DEMAIS para ser lido inteiro', () => {
    // O teto de 20 páginas (2000 itens) do `listarItensDoQuadro` existe para o
    // produto não girar para sempre. Mas até aqui a rota não escutava o aviso
    // do corte: ela reordenava o que deu, respondia "Reordenei 2 pedido(s)" e
    // dizia que o resto "não está no quadro" — quando estava, só não tinha
    // sido lido. Mentira na tela do dono, e do tipo que ele não tem como
    // desconfiar.
    const PROJETO = {
      id: 'p1',
      wingId: 'dono/repo',
      autonomia: 'cuidar',
      runtimeConfig: { envConfig: { GITORCH_PROJECT_BOARD: 'GitOrchAI/2' } },
    }

    /**
     * Sobe a rota com a rede FALSA no lugar do GitHub. Não é mock do nosso
     * cliente: a query, a paginação e o teto são os de verdade — só o outro
     * lado do fio é que é nosso. `semFim` decide se o quadro acaba ou não.
     */
    async function comQuadro(opts: { semFim: boolean }) {
      const eventCreate = vi.fn().mockResolvedValue({})
      const prisma = fakePrisma({
        project: { findFirst: vi.fn().mockResolvedValue(PROJETO) },
        event: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
          create: eventCreate,
        },
      })
      await build(prisma)
      ;(app as any).engineConnections = { getRawGithubToken: vi.fn().mockResolvedValue('tok_1') }

      let paginas = 0
      const fetchFalso = vi.fn(async (_url: any, init: any) => {
        const corpo = JSON.parse(String(init.body)) as { query: string }
        const responder = (data: unknown) =>
          new Response(JSON.stringify({ data }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })

        if (corpo.query.includes('GetProjectId')) {
          return responder({
            repositoryOwner: { __typename: 'Organization', projectV2: { id: 'PVT_1' } },
          })
        }
        if (corpo.query.includes('ItensDoQuadro')) {
          paginas++
          // Os pedidos que o dono mandou estão na PRIMEIRA página — a ordem
          // chega a ser aplicada. O corte não impede a escrita; ele só torna
          // a lista de "fora do quadro" mentirosa.
          const nodes =
            paginas === 1
              ? [
                  { id: 'PVTI_36', content: { number: 36 }, fieldValueByName: null },
                  { id: 'PVTI_37', content: { number: 37 }, fieldValueByName: null },
                ]
              : [
                  {
                    id: `PVTI_${paginas}`,
                    content: { number: 1000 + paginas },
                    fieldValueByName: null,
                  },
                ]
          const ultima = !opts.semFim && paginas === 20
          return responder({
            node: {
              items: {
                pageInfo: { hasNextPage: !ultima, endCursor: ultima ? null : `C_${paginas}` },
                nodes,
              },
            },
          })
        }
        return responder({ updateProjectV2ItemPosition: { items: { totalCount: 1 } } })
      })
      vi.stubGlobal('fetch', fetchFalso)

      const avisos = vi.spyOn(app.log, 'warn')
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/painel/ordem',
        headers: authHeaders,
        // #999 não existe em página nenhuma: é o "fora do quadro" legítimo.
        payload: { projeto: 'gitorch', pedidos: [36, 37, 999] },
      })
      return { res, eventCreate, avisos, paginas: () => paginas }
    }

    afterEach(() => vi.unstubAllGlobals())

    test('o corte NÃO passa calado: vira evento de auditoria, log e sinal na resposta', async () => {
      const { res, eventCreate, avisos, paginas } = await comQuadro({ semFim: true })

      expect(res.statusCode).toBe(200)
      // Leu até o teto e parou. Se este número mudar, o teste abaixo do fim
      // natural para de ser o vizinho de porta deste.
      expect(paginas()).toBe(20)

      // 1) O dono TEM que conseguir ver depois. A timeline do painel lê
      // `type: 'audit'` e renderiza `payload.texto` — gravar com outro tipo
      // seria gravar numa gaveta que nenhuma tela abre.
      const evento = eventCreate.mock.calls
        .map((c) => c[0].data)
        .find((d: any) => d.type === 'audit')
      expect(evento).toBeDefined()
      expect(evento.projectId).toBe('p1')
      expect(evento.payload.texto).toContain('não consegui ler o seu quadro inteiro')
      expect(evento.payload.itensLidos).toBe(21)

      // 2) E quem cuida da máquina também.
      expect(avisos).toHaveBeenCalled()

      // 3) A resposta não pode afirmar uma ordem inteira que não houve. Sem
      // este sinal a tela diz "#999 não está no quadro", quando a verdade é
      // "não sei se está — não li o quadro todo".
      const corpo = res.json()
      expect(corpo.leituraIncompleta).toBe(true)
      expect(corpo.itensLidos).toBe(21)
      expect(corpo.foraDoQuadro).toEqual([999])
    })

    test('quadro que ACABA dentro do teto não gera aviso nenhum', async () => {
      // O vizinho de porta: mesmas 20 páginas lidas, mesma ordem aplicada. Só
      // que o quadro acabou. Alarme falso aqui treinaria o dono a ignorar o
      // aviso do dia em que a leitura for cortada de verdade.
      const { res, eventCreate, avisos, paginas } = await comQuadro({ semFim: false })

      expect(res.statusCode).toBe(200)
      expect(paginas()).toBe(20)
      expect(eventCreate.mock.calls.map((c) => c[0].data.type)).not.toContain('audit')
      expect(avisos).not.toHaveBeenCalled()
      expect(res.json().leituraIncompleta).toBeUndefined()
    })
  })

  describe('resolveQuadroDoProjeto — o formato que o produto REALMENTE guarda', () => {
    // Eu tinha escrito a rota procurando um `githubBoardId` que o produto nunca
    // gravou. Conferido no banco do dono: o que existe é
    // `envConfig.GITORCH_PROJECT_BOARD` como "GitOrchAI/2". Inventar uma chave
    // nova fazia a rota responder "você não tem quadro" para quem tem.
    test('lê "dono/número" de envConfig, o mesmo que o scheduler lê', () => {
      expect(
        resolveQuadroDoProjeto({ envConfig: { GITORCH_PROJECT_BOARD: 'GitOrchAI/2' } })
      ).toEqual({ login: 'GitOrchAI', numero: 2 })
    })

    test('formato torto devolve null em vez de um quadro inventado', () => {
      for (const bruto of ['GitOrchAI', 'GitOrchAI/', '/2', 'a/b/c', 'GitOrchAI/zero', '']) {
        expect(resolveQuadroDoProjeto({ envConfig: { GITORCH_PROJECT_BOARD: bruto } })).toBeNull()
      }
    })

    test('número zero ou negativo não é quadro', () => {
      expect(resolveQuadroDoProjeto({ envConfig: { GITORCH_PROJECT_BOARD: 'x/0' } })).toBeNull()
      expect(resolveQuadroDoProjeto({ envConfig: { GITORCH_PROJECT_BOARD: 'x/-1' } })).toBeNull()
    })

    test('sem configuração nenhuma devolve null, sem estourar', () => {
      for (const cfg of [null, undefined, {}, [], 'texto', { envConfig: null }]) {
        expect(resolveQuadroDoProjeto(cfg)).toBeNull()
      }
    })
  })

  describe('a duração da sprint é do cliente', () => {
    // Decisão do dono (30/08): "nosso projeto de desenvolvimento 3 dias mas pra
    // clientes no painel eles decidem de quantos dias". O número deixa de ser
    // constante nossa no instante em que o produto passa a CRIAR o campo de
    // iteração no quadro dele.
    const getSprintDias = (qs = '') =>
      app.inject({ method: 'GET', url: `/api/v1/painel/sprint-dias${qs}`, headers: authHeaders })

    test('sem sessão → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/sprint-dias' })
      expect(res.statusCode).toBe(401)
    })

    test('GET sem escolha devolve o padrão e diz que ninguém escolheu', async () => {
      await build(
        fakePrisma({
          project: {
            findFirst: vi.fn().mockResolvedValue({ sprintDias: null, sprintDiasEscolhidoEm: null }),
          },
        })
      )
      const corpo = (await getSprintDias('?projeto=gitorch')).json()
      expect(corpo.dias).toBe(3)
      // A mesma distinção da régua e da autonomia: a tela não pode afirmar uma
      // decisão que não houve.
      expect(corpo.escolhido).toBe(false)
      expect(corpo.padrao).toBe(3)
    })

    test('GET com escolha devolve o que ele escolheu', async () => {
      await build(
        fakePrisma({
          project: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ sprintDias: 14, sprintDiasEscolhidoEm: new Date() }),
          },
        })
      )
      const corpo = (await getSprintDias('?projeto=gitorch')).json()
      expect(corpo.dias).toBe(14)
      expect(corpo.escolhido).toBe(true)
    })

    test('POST grava e carimba a escolha', async () => {
      const update = vi.fn().mockResolvedValue({})
      await build(
        fakePrisma({ project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1' }), update } })
      )
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/painel/sprint-dias',
        headers: authHeaders,
        payload: { projeto: 'gitorch', dias: 7 },
      })
      expect(res.statusCode).toBe(200)
      const dados = update.mock.calls[0]![0].data
      expect(dados.sprintDias).toBe(7)
      expect(dados.sprintDiasEscolhidoEm).toBeInstanceOf(Date)
    })

    test('recusa duração que quebraria o quadro em vez de configurá-lo', async () => {
      // 0 dias cria um ciclo que nunca fecha; 3650 torna "sprint" um nome
      // bonito para "sem prazo". As duas quebram a promessa do quadro.
      const update = vi.fn().mockResolvedValue({})
      await build(
        fakePrisma({ project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1' }), update } })
      )
      for (const dias of [0, -1, 61, 3650, 2.5]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/painel/sprint-dias',
          headers: authHeaders,
          payload: { projeto: 'gitorch', dias },
        })
        expect(res.statusCode, `dias=${dias} devia ser recusado`).toBe(400)
      }
      expect(update).not.toHaveBeenCalled()
    })

    test('projeto de outro dono devolve a MESMA frase de inexistente', async () => {
      // Mesmo anti-vazamento das outras rotas do painel: "não encontrado" e
      // "não é seu" não podem ser distinguíveis de fora.
      await build(fakePrisma({ project: { findFirst: vi.fn().mockResolvedValue(null) } }))
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/painel/sprint-dias',
        headers: authHeaders,
        payload: { projeto: 'de-outro', dias: 7 },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json().error).toBe('Projeto não encontrado.')
    })
  })

  describe('a régua é do cliente', () => {
    test('GET devolve a régua, os critérios e se ele escolheu', async () => {
      await build(
        fakePrisma({
          project: {
            findFirst: vi.fn().mockResolvedValue({ reguaDePronto: null, reguaEscolhidaEm: null }),
          },
        })
      )
      const corpo = (await getRegua('?projeto=gitorch')).json()
      expect(corpo.regua.no_ar).toBe(true)
      // Separa "ele escolheu" de "está no padrão porque ninguém escolheu".
      expect(corpo.escolhida).toBe(false)
      expect(corpo.criterios.map((c: { chave: string }) => c.chave)).toContain('no_ar')
    })

    test('POST grava e carimba a escolha', async () => {
      const update = vi.fn().mockResolvedValue({})
      await build(
        fakePrisma({
          project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1' }), update },
        })
      )
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/painel/regua',
        headers: authHeaders,
        payload: { projeto: 'gitorch', regua: { no_ar: false } },
      })
      expect(res.statusCode).toBe(200)
      const dados = update.mock.calls[0]![0].data
      expect(dados.reguaDePronto.no_ar).toBe(false)
      expect(dados.reguaEscolhidaEm).toBeInstanceOf(Date)
    })

    test('POST descarta o que não reconhece — não vira régua', async () => {
      const update = vi.fn().mockResolvedValue({})
      await build(
        fakePrisma({ project: { findFirst: vi.fn().mockResolvedValue({ id: 'p1' }), update } })
      )
      await app.inject({
        method: 'POST',
        url: '/api/v1/painel/regua',
        headers: authHeaders,
        payload: { projeto: 'gitorch', regua: { inventado: true, no_ar: 'sim' } },
      })
      const gravada = update.mock.calls[0]![0].data.reguaDePronto
      expect('inventado' in gravada).toBe(false)
      // 'sim' não é booleano: o critério fica no padrão, ligado.
      expect(gravada.no_ar).toBe(true)
    })

    test('projeto de OUTRO dono devolve a mesma frase de inexistente', async () => {
      await build(fakePrisma({ project: { findFirst: vi.fn().mockResolvedValue(null) } }))
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/painel/regua',
        headers: authHeaders,
        payload: { projeto: 'de-outro', regua: {} },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Projeto não encontrado.' })
    })
  })

  describe('GET /api/v1/painel/leitura', () => {
    const LIDO = {
      projeto: 'gitorch',
      repo: 'GitOrchAI/gitorch',
      disponivel: true,
      privado: false,
      linguagem: 'TypeScript',
      pedidosAbertos: 72,
      entregasAbertas: 19,
      quadros: { total: 1, vivos: 1, comSprint: 0 },
      ramoPrincipal: 'main',
      temVerificacao: true,
      ultimoCommit: '2026-08-29T18:36:49Z',
    }

    test('sem sessão, 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/leitura' })
      expect(res.statusCode).toBe(401)
    })

    test('devolve a leitura e quantos foram lidos', async () => {
      await build(fakePrisma(), { lerLeituras: async () => [LIDO] })
      const res = await getLeitura()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ leituras: [LIDO], lidos: 1 })
    })

    test('repositório indisponível NÃO conta como lido', async () => {
      // A diferença que impede a tela de dizer "li tudo e não achei nada"
      // quando na verdade não conseguiu abrir o repositório.
      const fora = {
        projeto: 'sumido',
        repo: 'd/sumido',
        disponivel: false,
        motivo: 'não consegui abrir',
      }
      await build(fakePrisma(), { lerLeituras: async () => [LIDO, fora] })
      const corpo = (await getLeitura()).json()
      expect(corpo.leituras).toHaveLength(2)
      expect(corpo.lidos).toBe(1)
    })

    test('quando NENHUM responde, 503 — nunca lista vazia', async () => {
      await build(fakePrisma(), {
        lerLeituras: async () => {
          throw new LeituraIndisponivelError('nenhum repositório respondeu')
        },
      })
      const res = await getLeitura()
      expect(res.statusCode).toBe(503)
      expect(res.json()).toEqual({ error: 'LEITURA_INDISPONIVEL' })
    })

    test('repassa o filtro de projeto', async () => {
      const espia = vi.fn().mockResolvedValue([])
      await build(fakePrisma(), { lerLeituras: espia })
      await getLeitura('?projeto=gitorch')
      expect(espia).toHaveBeenCalledWith(expect.objectContaining({ projeto: 'gitorch' }))
    })

    test('dono sem projeto: lista vazia com lidos 0, e isso é 200, não erro', async () => {
      await build(fakePrisma(), { lerLeituras: async () => [] })
      const res = await getLeitura()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ leituras: [], lidos: 0 })
    })
  })

  describe('GET /api/v1/painel/sprint', () => {
    // O ciclo de hoje precisa conter a data de execução do teste, senão o teste
    // passa hoje e quebra amanhã. Ancorar no "agora" é o que mantém honesto.
    //
    // E o "hoje" tem que ser o MESMO que a rota usa: `hojeNoFuso()`, em
    // America/Sao_Paulo. Estes testes calculavam a data em UTC, e entre 21h e
    // a meia-noite de Brasília os dois discordam — o teste montava uma sprint
    // começando "amanhã" e cobrava que ela estivesse correndo. Quebrou às
    // 00:04 UTC, exatamente nessa janela.
    const hoje = hojeNoFuso()
    const diasAtras = (n: number) => hojeNoFuso(new Date(Date.now() - n * 86400000))
    const ontem = diasAtras(1)
    const mesPassado = diasAtras(30)

    test('sem sessão → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/sprint' })
      expect(res.statusCode).toBe(401)
    })

    test('devolve a sprint que está valendo agora', async () => {
      await build(fakePrisma(), {
        lerSprints: async () => [
          {
            projeto: 'gitorch',
            iteracoes: [{ id: 'it', title: 'Sprint 12', startDate: ontem, duration: 3 }],
          },
        ],
      })
      const res = await getSprint()
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.sprints).toHaveLength(1)
      expect(body.sprints[0]).toMatchObject({
        projeto: 'gitorch',
        titulo: 'Sprint 12',
        inicio: ontem,
        dias: 3,
      })
    })

    test('nenhum quadro com sprint: lista vazia E configurados 0 — a tela sabe o que dizer', async () => {
      await build(fakePrisma(), { lerSprints: async () => [] })
      const body = (await getSprint()).json()
      expect(body).toEqual({ sprints: [], configurados: 0 })
    })

    test('tem sprint configurada mas hoje está ENTRE ciclos: sprints vazio e configurados 1', async () => {
      // Duas situações diferentes que davam a mesma tela vazia: "nunca teve
      // sprint" e "está no intervalo". `configurados` separa as duas.
      await build(fakePrisma(), {
        lerSprints: async () => [
          {
            projeto: 'gitorch',
            iteracoes: [{ id: 'velha', title: 'Sprint 1', startDate: mesPassado, duration: 3 }],
          },
        ],
      })
      const body = (await getSprint()).json()
      expect(body.sprints).toEqual([])
      expect(body.configurados).toBe(1)
    })

    test('consolida os projetos e respeita o filtro', async () => {
      const vistos: Array<{ projeto?: string }> = []
      await build(fakePrisma(), {
        lerSprints: async (args: { ownerId: string; projeto?: string }) => {
          vistos.push(args)
          return [
            {
              projeto: 'gitorch',
              iteracoes: [{ id: 'a', title: 'S1', startDate: hoje, duration: 3 }],
            },
            {
              projeto: 'patinhas-3d-crafts',
              iteracoes: [{ id: 'b', title: 'S7', startDate: hoje, duration: 3 }],
            },
          ]
        },
      })
      const body = (await getSprint()).json()
      expect(body.sprints.map((s: { projeto: string }) => s.projeto)).toEqual([
        'gitorch',
        'patinhas-3d-crafts',
      ])
      await getSprint('?projeto=gitorch')
      expect(vistos[1]?.projeto).toBe('gitorch')
    })

    test('o fim é o ÚLTIMO dia do ciclo, não o dia seguinte', async () => {
      await build(fakePrisma(), {
        lerSprints: async () => [
          {
            projeto: 'gitorch',
            iteracoes: [{ id: 'it', title: 'S', startDate: hoje, duration: 3 }],
          },
        ],
      })
      const s = (await getSprint()).json().sprints[0]
      const esperado = new Date(new Date(`${hoje}T00:00:00Z`).getTime() + 2 * 86400000)
        .toISOString()
        .slice(0, 10)
      expect(s.fim).toBe(esperado)
    })
  })

  describe('POST /api/v1/painel/decisoes/:id/responder', () => {
    const pergunta = (over: Record<string, any> = {}) => ({
      id: 'd1',
      userId: 'owner_1',
      status: 'open',
      answer: null,
      answeredVia: null,
      answeredAt: null,
      ...over,
    })
    const responder = (payload: any) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/painel/decisoes/d1/responder',
        headers: authHeaders,
        payload,
      })

    test('sem sessão → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/painel/decisoes/d1/responder',
        payload: { resposta: 'x' },
      })
      expect(res.statusCode).toBe(401)
    })

    test('resposta vazia → 400', async () => {
      await build(
        fakePrisma({ agentQuestion: { findUnique: vi.fn().mockResolvedValue(pergunta()) } })
      )
      expect((await responder({ resposta: '   ' })).statusCode).toBe(400)
      expect((await responder({})).statusCode).toBe(400)
    })

    test('pergunta de outra conta → 404 (mesma frase de inexistente)', async () => {
      await build(
        fakePrisma({
          agentQuestion: { findUnique: vi.fn().mockResolvedValue(pergunta({ userId: 'outro' })) },
        })
      )
      const res = await responder({ resposta: 'x' })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Decisão não encontrada.' })
    })

    test('pergunta inexistente → 404 (mesma frase)', async () => {
      await build(fakePrisma({ agentQuestion: { findUnique: vi.fn().mockResolvedValue(null) } }))
      const res = await responder({ resposta: 'x' })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Decisão não encontrada.' })
    })

    test('já respondida → 409 com a resposta que existe', async () => {
      await build(
        fakePrisma({
          agentQuestion: {
            findUnique: vi.fn().mockResolvedValue(
              pergunta({
                status: 'answered',
                answer: 'Separado',
                answeredVia: 'telegram',
                answeredAt: new Date('2026-08-27T12:00:00Z'),
              })
            ),
          },
        })
      )
      const res = await responder({ resposta: 'Junto' })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({
        code: 'JA_RESPONDIDA',
        answer: 'Separado',
        answeredVia: 'telegram',
        answeredAt: '2026-08-27T12:00:00.000Z',
      })
    })

    // D2 (fix-up 6, task a13a42f8-2953-4259-b41f-3f8cddb304cd): a pergunta
    // `assumida` (o RA formou suposição depois de 24h de silêncio, L4-T4/
    // D64) NÃO é bloqueada aqui — só `status === 'answered'` devolve 409.
    // O dono pode corrigir a suposição; a rota chama `answer()` (mesma
    // função do fluxo normal) normalmente, sem tratamento especial — quem
    // sabe que é uma CORREÇÃO é o manipulador (`retomar-sessao-com-
    // resposta.test.ts`), via `statusAnterior` no bag que `answer()` monta.
    test('pergunta ASSUMIDA (suposição do RA) → NÃO bloqueia (nunca 409), chama answer() e devolve 200', async () => {
      const answerImpl = vi.fn().mockResolvedValue({
        id: 'd1',
        answer: 'nao',
        answeredAt: new Date('2026-09-01T12:00:00Z'),
        answeredVia: 'panel',
        status: 'answered',
      })
      await build(
        fakePrisma({
          agentQuestion: {
            findUnique: vi.fn().mockResolvedValue(
              pergunta({
                status: 'assumida',
                answer: 'sim',
                answeredVia: 'ra-suposicao',
                answeredAt: new Date('2026-08-30T00:00:00Z'),
              })
            ),
          },
        }),
        { answerImpl }
      )
      const res = await responder({ resposta: 'nao' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'answered', answer: 'nao', answeredVia: 'panel' })
      expect(answerImpl).toHaveBeenCalledWith('d1', 'nao', 'panel')
    })

    test('ok → 200, answeredVia panel, sem campo interno vazando', async () => {
      const answerImpl = vi.fn().mockResolvedValue({
        id: 'd1',
        answer: 'Junto',
        answeredAt: new Date('2026-08-27T12:00:00Z'),
        answeredVia: 'panel',
        status: 'answered',
      })
      await build(
        fakePrisma({ agentQuestion: { findUnique: vi.fn().mockResolvedValue(pergunta()) } }),
        { answerImpl }
      )
      const res = await responder({ resposta: 'Junto' })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body).toEqual({
        id: 'd1',
        status: 'answered',
        answer: 'Junto',
        answeredAt: '2026-08-27T12:00:00.000Z',
        answeredVia: 'panel',
      })
      expect(body).not.toHaveProperty('userId')
      expect(body).not.toHaveProperty('dedupKey')
      expect(body).not.toHaveProperty('telegramMessageId')
      expect(body).not.toHaveProperty('projectId')
      expect(answerImpl).toHaveBeenCalledWith('d1', 'Junto', 'panel')
    })

    test('corrida: some entre findUnique e answer → 404', async () => {
      await build(
        fakePrisma({ agentQuestion: { findUnique: vi.fn().mockResolvedValue(pergunta()) } }),
        { answerImpl: vi.fn().mockResolvedValue(null) }
      )
      expect((await responder({ resposta: 'x' })).statusCode).toBe(404)
    })
  })

  // ESTEIRA-T14 — config por projeto de quanto o dono quer ver sobre dúvidas
  // do dev assíncrono. Sem GET dedicado: GET /api/projects já devolve
  // runtimeConfig por projeto (ROTAS.repos) — só o POST é novo aqui.
  describe('POST /api/v1/painel/duvida-config', () => {
    const postConfig = (body: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/painel/duvida-config',
        headers: authHeaders,
        payload: body,
      })

    test('sem sessão → 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/painel/duvida-config',
        payload: { projectId: 'p1', perguntasAoDono: 'tudo' },
      })
      expect(res.statusCode).toBe(401)
    })

    test('sem projectId → 400', async () => {
      await build()
      expect((await postConfig({ perguntasAoDono: 'tudo' })).statusCode).toBe(400)
    })

    test('valor inválido → 400, nunca grava lixo', async () => {
      const update = vi.fn()
      await build(
        fakePrisma({
          project: {
            findFirst: vi.fn().mockResolvedValue({ id: 'p1', runtimeConfig: null }),
            update,
          },
        })
      )
      expect(
        (await postConfig({ projectId: 'p1', perguntasAoDono: 'qualquer-coisa' })).statusCode
      ).toBe(400)
      expect(update).not.toHaveBeenCalled()
    })

    test('projeto de outro dono (ou inexistente) → 404, mesma frase das duas situações', async () => {
      await build(fakePrisma({ project: { findFirst: vi.fn().mockResolvedValue(null) } }))
      const res = await postConfig({ projectId: 'p1', perguntasAoDono: 'tudo' })
      expect(res.statusCode).toBe(404)
    })

    test('consulta o projeto escopado ao dono por id, nunca de outro', async () => {
      const findFirst = vi.fn().mockResolvedValue(null)
      await build(fakePrisma({ project: { findFirst } }))
      await postConfig({ projectId: 'p1', perguntasAoDono: 'tudo' })
      expect(findFirst.mock.calls[0]![0].where).toEqual({ id: 'p1', userId: 'owner_1' })
    })

    test('grava a política SEM apagar o resto do runtimeConfig (merge de uma chave)', async () => {
      const update = vi.fn().mockResolvedValue({})
      await build(
        fakePrisma({
          project: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ id: 'p1', runtimeConfig: { board: { sprintDays: 10 } } }),
            update,
          },
        })
      )
      const res = await postConfig({
        projectId: 'p1',
        perguntasAoDono: 'executivo-e-tecnico-bloqueante',
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ perguntasAoDono: 'executivo-e-tecnico-bloqueante' })
      expect(update.mock.calls[0]![0]).toEqual({
        where: { id: 'p1' },
        data: {
          runtimeConfig: {
            board: { sprintDays: 10 },
            perguntasAoDono: 'executivo-e-tecnico-bloqueante',
          },
        },
      })
    })
  })

  // ESTEIRA-T15 — a auditoria que não é mais spam no Telegram.
  describe('GET /api/v1/painel/timeline', () => {
    const getTimeline = () =>
      app.inject({ method: 'GET', url: '/api/v1/painel/timeline', headers: authHeaders })

    test('sem sessão → 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/painel/timeline' })
      expect(res.statusCode).toBe(401)
    })

    test('dono sem projeto → lista vazia, sem tocar Event', async () => {
      const prisma = await build(
        fakePrisma({ project: { findMany: vi.fn().mockResolvedValue([]) } })
      )
      expect((await getTimeline()).json()).toEqual({ eventos: [] })
      expect(prisma.event.findMany).not.toHaveBeenCalled()
    })

    test('devolve os eventos de auditoria, mais recente primeiro', async () => {
      const quando = new Date('2026-08-29T09:43:00Z')
      await build(
        fakePrisma({
          event: {
            findFirst: vi.fn().mockResolvedValue(null),
            findMany: vi
              .fn()
              .mockResolvedValue([
                { payload: { texto: 'GitOrch: 3 entregas barradas...' }, createdAt: quando },
              ]),
          },
        })
      )
      expect((await getTimeline()).json()).toEqual({
        eventos: [{ texto: 'GitOrch: 3 entregas barradas...', quando: quando.toISOString() }],
      })
    })

    test('só busca eventos type=audit, dos projetos do dono, teto de 10', async () => {
      const findMany = vi.fn().mockResolvedValue([])
      const prisma = await build(
        fakePrisma({
          project: { findMany: vi.fn().mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]) },
          event: { findFirst: vi.fn().mockResolvedValue(null), findMany },
        })
      )
      await getTimeline()
      expect(findMany.mock.calls[0]?.[0]).toMatchObject({
        where: { projectId: { in: ['p1', 'p2'] }, type: 'audit' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      })
      void prisma
    })

    test('payload sem texto (evento inesperado) não inventa conteúdo — string vazia', async () => {
      await build(
        fakePrisma({
          event: {
            findFirst: vi.fn().mockResolvedValue(null),
            findMany: vi.fn().mockResolvedValue([{ payload: {}, createdAt: new Date() }]),
          },
        })
      )
      expect((await getTimeline()).json().eventos[0].texto).toBe('')
    })
  })
})
