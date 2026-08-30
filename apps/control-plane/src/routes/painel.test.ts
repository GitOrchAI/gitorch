import { test, expect, describe, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { painelRoutes } from './painel.js'
import { LeituraIndisponivelError } from '../services/leitura-do-repositorio.js'
import { hojeNoFuso } from '../services/garantir-sprint.js'
import { ArvoreIndisponivelError } from '../services/arvore-de-pedidos.js'

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

    test('sem missão rodando → atuando vazio, motores vazio', async () => {
      const res = await getAgentes()
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ atuando: [], motores: [] })
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

  describe('GET /api/v1/painel/entregas — o que ficou pronto, e o que falta', () => {
    // Os estados são os que `dev_sessions` grava de verdade: deployState é
    // 'no-ar' | 'falhou' | 'publicando' | 'sem-publicacao' | 'commit-errado'.
    const PROJETOS = [{ id: 'p1', name: 'gitorch', reguaDePronto: null }]
    const sessao = (over: Record<string, unknown> = {}) => ({
      projectId: 'p1',
      issueNumber: 42,
      pullRequestNumber: 7,
      mergeCommitSha: 'deadbeef',
      deployState: 'no-ar',
      envLastVerdict: 'no-ar',
      updatedAt: new Date('2026-08-29T23:00:00Z'),
      ...over,
    })

    const prismaCom = (projetos: unknown[], sessoes: unknown[]) =>
      fakePrisma({
        project: { findMany: vi.fn().mockResolvedValue(projetos) },
        devSession: { findMany: vi.fn().mockResolvedValue(sessoes) },
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
      const corpo = (await getEntregas()).json()
      expect(corpo.prontas).toBe(0)
      expect(corpo.entregas[0].pronto).toBe(false)
      expect(corpo.entregas[0].porQueNaoFechou).toEqual([
        'foi mesclada, mas ainda não chegou ao ar',
      ])
    })

    test('entrega que não fechou tem data NULA — não usa a última mexida', async () => {
      // Mostrar `updatedAt` como se fosse a data da entrega diria que ficou
      // pronto num dia em que não ficou.
      await build(prismaCom(PROJETOS, [sessao({ deployState: 'falhou' })]))
      const corpo = (await getEntregas()).json()
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
      expect(res.json()).toEqual({ entregas: [], prontas: 0 })
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
  })

  describe('POST /api/v1/painel/ordem — a primeira rota que ESCREVE no cliente', () => {
    const PROJETO_COM_QUADRO = {
      id: 'p1',
      wingId: 'dono/repo',
      autonomia: 'cuidar',
      runtimeConfig: { githubBoardId: 'PVT_1' },
    }
    const PEDIDOS = [
      { pedido: 36, itemId: 'IT_36' },
      { pedido: 37, itemId: 'IT_37' },
    ]

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

    test('pedido malformado é DESCARTADO, e sobrando nada vira 400', async () => {
      // Um item sem itemId não dá para mover; aceitar e ignorar em silêncio
      // faria o cliente achar que a ordem inteira foi aplicada.
      await build(fakePrisma())
      const res = await postOrdem({ projeto: 'gitorch', pedidos: [{ pedido: 1 }, { itemId: '' }] })
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
