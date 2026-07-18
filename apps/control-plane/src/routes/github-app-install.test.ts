import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import jwt from 'jsonwebtoken'
import { resetEnvCache, getEnv } from '../config/env.js'
import { githubAppInstallRoutes } from './github-app-install.js'

/**
 * F1 Onda 2 — instalação do GitHub App por usuário, com seleção de repos.
 *
 * Diferente do login OAuth (routes/auth.ts, sem sessão prévia), este fluxo
 * PARTE de uma sessão já existente: a pessoa loga primeiro, depois decide
 * instalar o App para restringir quais repositórios o gitorch enxerga. Por
 * isso as duas rotas (/install e /install/callback) exigem `request.user` —
 * e o teste injeta a sessão via preHandler, mesmo padrão de
 * setup_environment_reset.test.ts.
 */
describe('GET /api/v1/auth/github/install', () => {
  let app: ReturnType<typeof Fastify>
  const PAGES = 'https://pages.example.test'
  const SAME_ORIGIN = 'https://api.example.test'

  const mountWithUser = async (userId = 'user_1'): Promise<void> => {
    app = Fastify()
    app.decorate('prisma', {
      user: { update: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: userId, wingId: 'octocat' }
    })
    await githubAppInstallRoutes(app)
    await app.ready()
  }

  beforeEach(() => {
    process.env['FRONTEND_URL'] = PAGES
    process.env['GITORCH_PUBLIC_URL'] = SAME_ORIGIN
    process.env['CORS_ORIGIN'] = `${PAGES},${SAME_ORIGIN}`
    process.env['GITHUB_APP_SLUG'] = 'gitorch-ai'
    resetEnvCache()
  })

  afterEach(async () => {
    await app?.close()
    resetEnvCache()
    delete process.env['GITORCH_PUBLIC_URL']
    delete process.env['CORS_ORIGIN']
    delete process.env['GITHUB_APP_SLUG']
  })

  it('sem sessão, recusa com 401 (nunca chega a redirecionar pro GitHub)', async () => {
    app = Fastify()
    app.decorate('prisma', { user: { update: vi.fn() } } as unknown as never)
    await githubAppInstallRoutes(app)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/github/install' })
    expect(res.statusCode).toBe(401)
  })

  it('sem GITHUB_APP_SLUG configurado, 500 honesto (não inventa um slug)', async () => {
    delete process.env['GITHUB_APP_SLUG']
    resetEnvCache()
    await mountWithUser()

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/github/install' })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toContain('GITHUB_APP_SLUG')
  })

  it('com sessão, redireciona à página de instalação do App com state assinado carregando o userId', async () => {
    await mountWithUser('user_42')

    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/github/install' })

    expect(res.statusCode).toBe(302)
    const location = new URL(res.headers.location as string)
    expect(location.origin + location.pathname).toBe(
      'https://github.com/apps/gitorch-ai/installations/new'
    )
    const state = location.searchParams.get('state')
    expect(state).toBeTruthy()
    const decoded = jwt.verify(state as string, getEnv().JWT_SECRET) as {
      userId: string
      returnTo: string
    }
    expect(decoded.userId).toBe('user_42')
    expect(decoded.returnTo).toBe(PAGES)
  })

  it('carrega no state a origem de quem entrou (same-origin), quando permitida', async () => {
    await mountWithUser()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/install?return_to=${encodeURIComponent(SAME_ORIGIN)}`,
    })

    const state = new URL(res.headers.location as string).searchParams.get('state')
    const decoded = jwt.verify(state as string, getEnv().JWT_SECRET) as { returnTo: string }
    expect(decoded.returnTo).toBe(SAME_ORIGIN)
  })

  it('destino fora da allowlist é ignorado — cai no FRONTEND_URL (nunca open redirect)', async () => {
    await mountWithUser()

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/install?return_to=${encodeURIComponent('https://evil.example.com')}`,
    })

    const state = new URL(res.headers.location as string).searchParams.get('state')
    const decoded = jwt.verify(state as string, getEnv().JWT_SECRET) as { returnTo: string }
    expect(decoded.returnTo).toBe(PAGES)
  })
})

describe('GET /api/v1/auth/github/install/callback', () => {
  let app: ReturnType<typeof Fastify>
  let prismaUpdate: ReturnType<typeof vi.fn>
  const PAGES = 'https://pages.example.test'

  const mountWithUser = async (userId = 'user_1'): Promise<void> => {
    prismaUpdate = vi.fn().mockResolvedValue({ id: userId })
    app = Fastify()
    app.decorate('prisma', {
      user: { update: prismaUpdate },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: userId, wingId: 'octocat' }
    })
    await githubAppInstallRoutes(app)
    await app.ready()
  }

  const stateFor = (userId: string, returnTo = PAGES): string =>
    jwt.sign({ userId, returnTo }, getEnv().JWT_SECRET, { expiresIn: '10m' })

  beforeEach(() => {
    process.env['FRONTEND_URL'] = PAGES
    process.env['GITHUB_APP_SLUG'] = 'gitorch-ai'
    resetEnvCache()
  })

  afterEach(async () => {
    await app?.close()
    resetEnvCache()
    delete process.env['GITHUB_APP_SLUG']
  })

  it('sem sessão, 401 — não grava nada', async () => {
    app = Fastify()
    app.decorate('prisma', { user: { update: vi.fn() } } as unknown as never)
    await githubAppInstallRoutes(app)
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/install/callback?installation_id=123&setup_action=install',
    })
    expect(res.statusCode).toBe(401)
  })

  it('sem state, 400', async () => {
    await mountWithUser()
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/install/callback?installation_id=123&setup_action=install',
    })
    expect(res.statusCode).toBe(400)
    expect(prismaUpdate).not.toHaveBeenCalled()
  })

  it('state adulterado/expirado, 400 (anti-CSRF)', async () => {
    await mountWithUser()
    const forjado = jwt.sign({ userId: 'user_1' }, 'segredo-errado')
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/install/callback?installation_id=123&setup_action=install&state=${encodeURIComponent(forjado)}`,
    })
    expect(res.statusCode).toBe(400)
    expect(prismaUpdate).not.toHaveBeenCalled()
  })

  it('state de OUTRO usuário (não bate com a sessão atual), 400 — não grava na conta errada', async () => {
    await mountWithUser('user_vitima')
    const stateDeOutraConta = stateFor('user_atacante')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/install/callback?installation_id=123&setup_action=install&state=${encodeURIComponent(stateDeOutraConta)}`,
    })

    expect(res.statusCode).toBe(400)
    expect(prismaUpdate).not.toHaveBeenCalled()
  })

  it('setup_action=request (aguardando aprovação de admin da org): redireciona sem gravar nada', async () => {
    await mountWithUser('user_1')
    const state = stateFor('user_1')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/install/callback?setup_action=request&state=${encodeURIComponent(state)}`,
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${PAGES}/setup`)
    expect(prismaUpdate).not.toHaveBeenCalled()
  })

  it('installation_id inválido (não numérico/<=0), 400', async () => {
    await mountWithUser('user_1')
    const state = stateFor('user_1')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/install/callback?installation_id=abc&setup_action=install&state=${encodeURIComponent(state)}`,
    })

    expect(res.statusCode).toBe(400)
    expect(prismaUpdate).not.toHaveBeenCalled()
  })

  it('caminho feliz: grava githubInstallationId no User da sessão e redireciona pro /setup', async () => {
    await mountWithUser('user_1')
    const state = stateFor('user_1')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/install/callback?installation_id=98765&setup_action=install&state=${encodeURIComponent(state)}`,
    })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${PAGES}/setup`)
    expect(prismaUpdate).toHaveBeenCalledWith({
      where: { id: 'user_1' },
      data: { githubInstallationId: 98765 },
    })
  })

  it('devolve para a origem carregada no state (returnTo), não sempre o FRONTEND_URL', async () => {
    process.env['GITORCH_PUBLIC_URL'] = 'https://api.example.test'
    process.env['CORS_ORIGIN'] = 'https://api.example.test'
    resetEnvCache()
    await mountWithUser('user_1')
    const state = stateFor('user_1', 'https://api.example.test')

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/install/callback?installation_id=1&setup_action=install&state=${encodeURIComponent(state)}`,
    })

    expect(res.headers.location).toBe('https://api.example.test/setup')
    delete process.env['GITORCH_PUBLIC_URL']
    delete process.env['CORS_ORIGIN']
  })
})
