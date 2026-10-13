import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { entregaRoutes } from './entrega.js'

// Rota interna do entregador: loopback REAL do soquete + segredo de serviço, e
// 404 para qualquer outra coisa (a rota não se revela a quem não é o chamador).

const TOKEN = 'segredo-de-servico-para-teste-0123456789'

interface Contagens {
  missionRunning: number
  missionWaiting: number
  diag: number
  logins: number
}

function montarApp(opts: { ligada: boolean; contagens?: Partial<Contagens> }) {
  const c: Contagens = {
    missionRunning: 0,
    missionWaiting: 0,
    diag: 0,
    logins: 0,
    ...opts.contagens,
  }
  let linha: Record<string, unknown> | null = opts.ligada
    ? {
        id: 'entrega',
        ligada: true,
        desde: new Date('2030-01-01T10:00:00Z'),
        motivo: 'm',
        ligadaPor: 'p',
      }
    : null
  const prisma = {
    travaDeEntrega: {
      findUnique: vi.fn(async () => linha),
      upsert: vi.fn(
        async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
          linha = linha ? { ...linha, ...args.update } : { ...args.create }
          return linha
        }
      ),
    },
    mission: {
      count: vi.fn(async (args: { where: { status: unknown } }) => {
        const st = args.where.status
        if (st === 'running') return c.missionRunning
        return c.missionWaiting
      }),
    },
    diagnosisJob: { count: vi.fn(async () => c.diag) },
    devSession: { count: vi.fn(async () => 7) },
  }
  const app = Fastify()
  app.decorate('prisma', prisma as never)
  app.decorate('assistedLogin', { contarAbertas: () => c.logins } as never)
  return { app, prisma }
}

const cab = { 'x-entrega-token': TOKEN }

describe('rotas internas de entrega', () => {
  const original = process.env['GITORCH_ENTREGA_TOKEN']
  beforeEach(() => {
    process.env['GITORCH_ENTREGA_TOKEN'] = TOKEN
  })
  afterEach(() => {
    if (original === undefined) delete process.env['GITORCH_ENTREGA_TOKEN']
    else process.env['GITORCH_ENTREGA_TOKEN'] = original
  })

  async function pronto(opts: Parameters<typeof montarApp>[0]) {
    const { app, prisma } = montarApp(opts)
    await entregaRoutes(app)
    await app.ready()
    return { app, prisma }
  }

  it('GET com loopback + segredo: devolve a trava, o que está em andamento e podeTrocar', async () => {
    const { app } = await pronto({ ligada: true })
    const res = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      headers: cab,
      remoteAddress: '127.0.0.1',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      trava: {
        ligada: true,
        desde: '2030-01-01T10:00:00.000Z',
        motivo: 'm',
        ligadaPor: 'p',
      },
      emAndamento: {
        missoesRodando: 0,
        missoesEsperando: 0,
        diagnosticosRodando: 0,
        loginsAssistidosAbertos: 0,
        sessoesDoDevVivas: 7,
      },
      podeTrocar: true,
    })
  })

  it('aceita ::1 e ::ffff:127.0.0.1 como loopback', async () => {
    const { app } = await pronto({ ligada: false })
    for (const ip of ['::1', '::ffff:127.0.0.1']) {
      const res = await app.inject({
        method: 'GET',
        url: '/interno/entrega',
        headers: cab,
        remoteAddress: ip,
      })
      expect(res.statusCode).toBe(200)
    }
  })

  it('sem o segredo: 404', async () => {
    const { app } = await pronto({ ligada: false })
    const res = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      remoteAddress: '127.0.0.1',
    })
    expect(res.statusCode).toBe(404)
  })

  it('segredo errado (mesmo tamanho e de tamanho diferente): 404', async () => {
    const { app } = await pronto({ ligada: false })
    for (const errado of [TOKEN.replace(/.$/, 'x'), 'curto', TOKEN + 'a']) {
      const res = await app.inject({
        method: 'GET',
        url: '/interno/entrega',
        headers: { 'x-entrega-token': errado },
        remoteAddress: '127.0.0.1',
      })
      expect(res.statusCode).toBe(404)
    }
  })

  it('variável de ambiente ausente (ou vazia): 404 mesmo com o cabeçalho', async () => {
    const { app } = await pronto({ ligada: false })
    delete process.env['GITORCH_ENTREGA_TOKEN']
    const sem = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      headers: { 'x-entrega-token': '' },
      remoteAddress: '127.0.0.1',
    })
    expect(sem.statusCode).toBe(404)
    process.env['GITORCH_ENTREGA_TOKEN'] = ''
    const vazia = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      headers: { 'x-entrega-token': '' },
      remoteAddress: '127.0.0.1',
    })
    expect(vazia.statusCode).toBe(404)
  })

  it('de fora do loopback, mesmo com o segredo certo: 404', async () => {
    const { app } = await pronto({ ligada: false })
    const res = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      headers: cab,
      remoteAddress: '203.0.113.9',
    })
    expect(res.statusCode).toBe(404)
  })

  it('pedido que passou por proxy (cabeçalho de encaminhamento) é de fora, mesmo vindo do loopback', async () => {
    const { app } = await pronto({ ligada: false })
    for (const h of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      const res = await app.inject({
        method: 'GET',
        url: '/interno/entrega',
        headers: { ...cab, [h]: '203.0.113.9' },
        remoteAddress: '127.0.0.1',
      })
      expect(res.statusCode).toBe(404)
    }
  })

  it('cabeçalho X-Forwarded-For de loopback NÃO faz um endereço de fora passar', async () => {
    const { app } = await pronto({ ligada: false })
    const res = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      headers: { ...cab, 'x-forwarded-for': '127.0.0.1' },
      remoteAddress: '203.0.113.9',
    })
    expect(res.statusCode).toBe(404)
  })

  it('POST ligar: liga a trava (idempotente) e devolve o estado', async () => {
    const { app, prisma } = await pronto({ ligada: false })
    const primeira = await app.inject({
      method: 'POST',
      url: '/interno/entrega/ligar',
      headers: cab,
      remoteAddress: '127.0.0.1',
      payload: { motivo: 'troca de versão', por: 'entregador' },
    })
    expect(primeira.statusCode).toBe(200)
    expect(primeira.json().trava).toMatchObject({
      ligada: true,
      motivo: 'troca de versão',
      ligadaPor: 'entregador',
    })
    const segunda = await app.inject({
      method: 'POST',
      url: '/interno/entrega/ligar',
      headers: cab,
      remoteAddress: '127.0.0.1',
      payload: { motivo: 'outro', por: 'outro' },
    })
    expect(segunda.json().trava.motivo).toBe('troca de versão')
    expect(prisma.travaDeEntrega.upsert).toHaveBeenCalledTimes(1)
  })

  it('POST ligar sem corpo usa motivo e autor padrão', async () => {
    const { app } = await pronto({ ligada: false })
    const res = await app.inject({
      method: 'POST',
      url: '/interno/entrega/ligar',
      headers: cab,
      remoteAddress: '127.0.0.1',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().trava.ligada).toBe(true)
    expect(res.json().trava.ligadaPor).toBe('entregador')
  })

  it('POST desligar: solta a trava (idempotente)', async () => {
    const { app } = await pronto({ ligada: true })
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/interno/entrega/desligar',
        headers: cab,
        remoteAddress: '127.0.0.1',
        payload: { por: 'entregador' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().trava).toEqual({
        ligada: false,
        desde: null,
        motivo: null,
        ligadaPor: null,
      })
    }
  })

  it.each(['/interno/entrega/ligar', '/interno/entrega/desligar'])(
    'POST %s sem segredo ou de fora: 404 e nada muda',
    async (url) => {
      const { app, prisma } = await pronto({ ligada: false })
      const semSegredo = await app.inject({ method: 'POST', url, remoteAddress: '127.0.0.1' })
      const deFora = await app.inject({
        method: 'POST',
        url,
        headers: cab,
        remoteAddress: '198.51.100.4',
      })
      expect(semSegredo.statusCode).toBe(404)
      expect(deFora.statusCode).toBe(404)
      expect(prisma.travaDeEntrega.upsert).not.toHaveBeenCalled()
    }
  )

  describe('podeTrocar', () => {
    async function consultar(opts: Parameters<typeof montarApp>[0]) {
      const { app } = await pronto(opts)
      const res = await app.inject({
        method: 'GET',
        url: '/interno/entrega',
        headers: cab,
        remoteAddress: '127.0.0.1',
      })
      return res.json() as { podeTrocar: boolean; emAndamento: Contagens & Record<string, number> }
    }

    it('trava desligada: nunca pode trocar, mesmo sem nada rodando', async () => {
      expect((await consultar({ ligada: false })).podeTrocar).toBe(false)
    })

    it('ligada e tudo zerado: pode trocar', async () => {
      expect((await consultar({ ligada: true })).podeTrocar).toBe(true)
    })

    it('missão rodando impede', async () => {
      expect((await consultar({ ligada: true, contagens: { missionRunning: 1 } })).podeTrocar).toBe(
        false
      )
    })

    it('diagnóstico rodando impede', async () => {
      expect((await consultar({ ligada: true, contagens: { diag: 1 } })).podeTrocar).toBe(false)
    })

    it('login assistido aberto impede', async () => {
      expect((await consultar({ ligada: true, contagens: { logins: 1 } })).podeTrocar).toBe(false)
    })

    it('missão esperando (pending/waiting) e sessão do dev viva NÃO impedem', async () => {
      const r = await consultar({ ligada: true, contagens: { missionWaiting: 4 } })
      expect(r.podeTrocar).toBe(true)
      expect(r.emAndamento['missoesEsperando']).toBe(4)
      expect(r.emAndamento['sessoesDoDevVivas']).toBe(7)
    })
  })

  it('falha ao contar o que está em andamento: 500 (nunca um "pode trocar" no escuro)', async () => {
    const { app, prisma } = await pronto({ ligada: true })
    prisma.mission.count.mockRejectedValue(new Error('banco fora'))
    const res = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      headers: cab,
      remoteAddress: '127.0.0.1',
    })
    expect(res.statusCode).toBe(500)
    expect(res.json().podeTrocar).not.toBe(true)
  })
})

describe('rotas internas de entrega com a autenticação REAL do produto', () => {
  const original = process.env['GITORCH_ENTREGA_TOKEN']
  afterEach(() => {
    if (original === undefined) delete process.env['GITORCH_ENTREGA_TOKEN']
    else process.env['GITORCH_ENTREGA_TOKEN'] = original
  })

  it('o chamador legítimo passa sem login do painel; quem não é o entregador recebe 404, não 401', async () => {
    process.env['GITORCH_ENTREGA_TOKEN'] = TOKEN
    const { loadEnv } = await import('../config/env.js')
    const { registerPlugins } = await import('../plugins/index.js')
    const app = Fastify()
    await registerPlugins(app, loadEnv())
    await entregaRoutes(app)
    await app.ready()
    const p = app.prisma as unknown as Record<string, Record<string, unknown>>
    p['travaDeEntrega']!['findUnique'] = vi.fn().mockResolvedValue(null)
    p['mission']!['count'] = vi.fn().mockResolvedValue(0)
    p['diagnosisJob'] = { count: vi.fn().mockResolvedValue(0) }
    p['devSession']!['count'] = vi.fn().mockResolvedValue(0)

    const ok = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      headers: cab,
      remoteAddress: '127.0.0.1',
    })
    expect(ok.statusCode).toBe(200)

    const semSegredo = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      remoteAddress: '127.0.0.1',
    })
    expect(semSegredo.statusCode).toBe(404)

    const deFora = await app.inject({
      method: 'GET',
      url: '/interno/entrega',
      headers: cab,
      remoteAddress: '203.0.113.9',
    })
    expect(deFora.statusCode).toBe(404)
    await app.close()
  })
})
