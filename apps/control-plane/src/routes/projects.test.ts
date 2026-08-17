import { test, it, expect, describe, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import jwt from 'jsonwebtoken'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { projectRoutes } from './projects.js'
import { runtimeConfigRoutes } from './runtime-config.js'

describe('Project Routes', () => {
  let app: ReturnType<typeof Fastify>
  let authHeaders: { authorization: string }

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await projectRoutes(app)
    await runtimeConfigRoutes(app)

    // Autentica pelo fluxo real (JWT assinado com o segredo do ambiente):
    // o hook de auth é global e rejeita requisições sem Bearer válido.
    const token = jwt.sign({ userId: 'user_123', wingId: 'wing_123' }, env.JWT_SECRET)
    authHeaders = { authorization: `Bearer ${token}` }

    await app.ready()
  })

  test('GET /api/projects returns projects list', async () => {
    app.prisma.project.findMany = vi.fn().mockResolvedValue([{ id: 'proj_456', name: 'Test' }])
    app.prisma.project.count = vi.fn().mockResolvedValue(1)

    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: authHeaders })

    expect(res.statusCode).toBe(200)
    expect(res.json().data).toHaveLength(1)
  })

  test('PATCH /api/projects/:id/runtime-config updates config', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_456', wingId: 'wing_123' })
    app.prisma.project.update = vi.fn().mockResolvedValue({
      id: 'proj_456',
      name: 'Test',
      runtimeConfig: { model: 'gpt-4' },
    })

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/projects/proj_456/runtime-config',
      headers: authHeaders,
      payload: { runtimeConfig: { model: 'gpt-4' } },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json().runtimeConfig).toEqual({ model: 'gpt-4' })
  })

  test('PATCH /api/projects/:id/runtime-config aceita o plano do dev assíncrono e recusa valor inventado', async () => {
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_456', wingId: 'wing_123' })
    // Mock guardado numa variável (em vez de inline) para dar pra inspecionar
    // os argumentos REAIS que a rota mandou pro Prisma — só conferir o corpo
    // da resposta HTTP não prova nada, porque o mock devolve 'pro' de
    // qualquer jeito, mesmo que a rota nunca repasse devPlan pro `data`.
    const updateMock = vi.fn().mockResolvedValue({
      id: 'proj_456',
      name: 'Test',
      devPlan: 'pro',
    })
    app.prisma.project.update = updateMock

    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/projects/proj_456/runtime-config',
      headers: authHeaders,
      payload: { devPlan: 'pro' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().devPlan).toBe('pro')
    // Prova de verdade #1: o devPlan que veio no corpo da requisição tem que
    // chegar ao `data` do update do Prisma — não só ao JSON da resposta.
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ devPlan: 'pro' }) })
    )

    const ruim = await app.inject({
      method: 'PATCH',
      url: '/api/projects/proj_456/runtime-config',
      headers: authHeaders,
      payload: { devPlan: 'enterprise' },
    })
    expect(ruim.statusCode).toBe(400)

    // Prova de verdade #2: devPlan AUSENTE no corpo não pode apagar o plano
    // já salvo. A rota monta o `data` só com as chaves que vieram na
    // requisição, então um PATCH que só mexe em runtimeConfig não pode levar
    // a chave devPlan junto (nem como undefined) pro update do Prisma.
    const semDevPlan = await app.inject({
      method: 'PATCH',
      url: '/api/projects/proj_456/runtime-config',
      headers: authHeaders,
      payload: { runtimeConfig: { model: 'gpt-4' } },
    })
    expect(semDevPlan.statusCode).toBe(200)
    const ultimaChamada = updateMock.mock.calls[updateMock.mock.calls.length - 1]![0] as {
      data: Record<string, unknown>
    }
    expect(ultimaChamada.data).not.toHaveProperty('devPlan')
  })

  /**
   * A MESMA porta do callback de instalação, num corredor diferente.
   *
   * `githubInstallationId` e `githubRepoId` são a IDENTIDADE do projeto no
   * GitHub — é por eles que o webhook decide de quem é cada entrega
   * (routes/github-webhook.ts monta um OR com os dois). Aceitá-los do corpo da
   * requisição deixava qualquer cliente logado carimbar no próprio projeto a
   * instalação/repositório de outra pessoa e passar a receber os eventos dela.
   *
   * Estes campos têm UMA fonte legítima: o payload do webhook, que chega
   * assinado por HMAC e é preenchido pela auto-cura lá mesmo. Do cliente, não
   * entram — e a recusa é explícita, para ninguém achar que gravou.
   */
  describe('identidade do projeto no GitHub não vem do cliente', () => {
    it('ATAQUE: POST /api/projects com a instalação da vítima é recusado, e nada é criado', async () => {
      app.prisma.project.findFirst = vi.fn().mockResolvedValue(null)
      const createMock = vi.fn().mockResolvedValue({ id: 'proj_novo' })
      app.prisma.project.create = createMock

      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders,
        payload: { name: 'Projeto do Mallory', githubInstallationId: 424242 },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('CAMPO_NAO_ACEITO')
      expect(createMock).not.toHaveBeenCalled()
    })

    it('ATAQUE: POST /api/projects com o repositório da vítima (githubRepoId) é recusado', async () => {
      app.prisma.project.findFirst = vi.fn().mockResolvedValue(null)
      const createMock = vi.fn().mockResolvedValue({ id: 'proj_novo' })
      app.prisma.project.create = createMock

      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders,
        payload: { name: 'Outro do Mallory', githubRepoId: 1319993284 },
      })

      expect(res.statusCode).toBe(400)
      expect(createMock).not.toHaveBeenCalled()
    })

    it('ATAQUE: PATCH /api/projects/:id não deixa carimbar a instalação da vítima depois', async () => {
      app.prisma.project.findFirst = vi
        .fn()
        .mockResolvedValue({ id: 'proj_456', wingId: 'wing_123', name: 'Test' })
      const updateMock = vi.fn().mockResolvedValue({ id: 'proj_456' })
      app.prisma.project.update = updateMock

      const res = await app.inject({
        method: 'PATCH',
        url: '/api/projects/proj_456',
        headers: authHeaders,
        payload: { githubInstallationId: 424242 },
      })

      expect(res.statusCode).toBe(400)
      expect(res.json().code).toBe('CAMPO_NAO_ACEITO')
      expect(updateMock).not.toHaveBeenCalled()
    })

    it('criar projeto sem esses campos segue funcionando normalmente', async () => {
      app.prisma.project.findFirst = vi.fn().mockResolvedValue(null)
      const createMock = vi.fn().mockResolvedValue({ id: 'proj_novo', name: 'Legítimo' })
      app.prisma.project.create = createMock

      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: authHeaders,
        payload: { name: 'Legítimo' },
      })

      expect(res.statusCode).toBe(201)
      const dadosCriados = (createMock.mock.calls[0]![0] as { data: Record<string, unknown> }).data
      expect(dadosCriados).not.toHaveProperty('githubInstallationId')
      expect(dadosCriados).not.toHaveProperty('githubRepoId')
    })
  })
})
