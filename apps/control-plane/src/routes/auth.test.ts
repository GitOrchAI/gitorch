import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import jwt from 'jsonwebtoken'
import rateLimit from '@fastify/rate-limit'
import { resetEnvCache } from '../config/env.js'
import { authRoutes } from './auth.js'
import { authPlugin } from '../plugins/auth.js'
import type { EngineConnectionService } from '../services/engine-connection.js'

describe('GitHub OAuth callback', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  let connectGitHubToken: ReturnType<typeof vi.fn>
  let userUpsert: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    process.env['GITHUB_CLIENT_ID'] = 'test-client-id'
    process.env['GITHUB_CLIENT_SECRET'] = 'test-client-secret'
    process.env['FRONTEND_URL'] = 'https://app.example.test'
    resetEnvCache()

    connectGitHubToken = vi.fn().mockResolvedValue({ status: 'connected' })
    userUpsert = vi.fn().mockImplementation(async ({ create }) => ({
      id: 'dbuser_cuid_123',
      email: create.email,
      githubLogin: create.githubLogin,
    }))

    app = Fastify()
    await app.register(fastifyCookie)
    // engineConnections é decorado pelo plugin real (engines.ts) a partir do
    // Prisma; aqui isolamos o teste da camada de dados com um double —
    // a persistência em si já tem cobertura própria em engine-connection.test.ts.
    app.decorate('engineConnections', {
      connectGitHubToken,
    } as unknown as EngineConnectionService)
    // idem para o Prisma: só o upsert de User importa pra este teste.
    app.decorate('prisma', {
      user: { upsert: userUpsert },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await authRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
    resetEnvCache()
  })

  it('sets an httpOnly session cookie and redirects without a token query param', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.includes('github.com/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gh_raw_token' }), { status: 200 })
      }
      if (href.includes('api.github.com/user')) {
        return new Response(
          JSON.stringify({ id: 42, login: 'octocat', email: 'octocat@example.test' }),
          { status: 200 }
        )
      }
      throw new Error(`unexpected fetch ${href}`)
    }) as unknown as typeof fetch

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?code=abc123',
    })

    expect(res.statusCode).toBe(302)
    const location = res.headers.location as string
    expect(location).toBe('https://app.example.test/setup')
    expect(location).not.toContain('token=')

    const setCookie = res.headers['set-cookie']
    expect(setCookie).toBeDefined()
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie
    expect(cookieHeader).toContain('gitorch_session=')
    expect(cookieHeader).toContain('HttpOnly')
    // Front (GitHub Pages/NEXT_PUBLIC_API_URL) e control-plane vivem em
    // origens diferentes em produção — SameSite=Lax nunca acompanha um
    // fetch/XHR cross-site (só navegação top-level), então todo
    // credentials:'include' subsequente voltaria 401 logo após o login.
    expect(cookieHeader).toContain('SameSite=None')
    expect(cookieHeader).toContain('Secure')

    const tokenMatch = cookieHeader?.match(/gitorch_session=([^;]+)/)
    expect(tokenMatch).not.toBeNull()
    const decoded = jwt.decode(tokenMatch![1]) as Record<string, unknown>
    // userId é o id REAL do Prisma User (cuid), não o id numérico do GitHub —
    // é a chave que EngineConnection.userId e Project.userId esperam por
    // inteiro no restante do código (ver resolveUserId em plugins/engines.ts).
    expect(decoded['userId']).toBe('dbuser_cuid_123')
    expect(decoded['wingId']).toBe('octocat')
    // O token do GitHub NÃO pode viajar no JWT da sessão (spec §17.4).
    expect(decoded['githubToken']).toBeUndefined()

    // O User é criado/atualizado no login (nenhum outro lugar do código faz
    // isso hoje) — sem isso, owner nunca resolve pra clientes novos.
    expect(userUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'octocat@example.test' },
        create: expect.objectContaining({
          email: 'octocat@example.test',
          githubLogin: 'octocat',
        }),
      })
    )

    // O token do GitHub é persistido cifrado pelo id REAL do usuário, não o
    // id numérico do GitHub nem um valor solto.
    expect(connectGitHubToken).toHaveBeenCalledWith('dbuser_cuid_123', 'gh_raw_token')
  })

  it('keeps SameSite=Lax without Secure in local dev (http, same-site ports)', async () => {
    // env é lido (getEnv) no momento em que authRoutes(app) registra a rota —
    // por isso este teste monta seu PRÓPRIO app, com NODE_ENV=development
    // setado ANTES do registro, em vez de reaproveitar o app do beforeEach
    // (que já capturou NODE_ENV=test ao registrar as rotas).
    process.env['NODE_ENV'] = 'development'
    resetEnvCache()

    const devApp = Fastify()
    await devApp.register(fastifyCookie)
    devApp.decorate('engineConnections', {
      connectGitHubToken,
    } as unknown as EngineConnectionService)
    devApp.decorate('prisma', { user: { upsert: userUpsert } } as any) // eslint-disable-line @typescript-eslint/no-explicit-any
    await authRoutes(devApp)
    await devApp.ready()

    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.includes('github.com/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gh_raw_token' }), { status: 200 })
      }
      if (href.includes('api.github.com/user')) {
        return new Response(
          JSON.stringify({ id: 42, login: 'octocat', email: 'octocat@example.test' }),
          { status: 200 }
        )
      }
      throw new Error(`unexpected fetch ${href}`)
    }) as unknown as typeof fetch

    try {
      const res = await devApp.inject({
        method: 'GET',
        url: '/api/v1/auth/github/callback?code=abc123',
      })

      const setCookie = res.headers['set-cookie']
      const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie
      expect(cookieHeader).toContain('SameSite=Lax')
      expect(cookieHeader).not.toContain('Secure')
    } finally {
      process.env['NODE_ENV'] = 'test'
      resetEnvCache()
    }
  })

  it('falls back to /user/emails when /user returns no public email', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.includes('github.com/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gh_raw_token' }), { status: 200 })
      }
      if (href.includes('api.github.com/user/emails')) {
        return new Response(
          JSON.stringify([
            { email: 'secondary@example.test', primary: false, verified: true },
            { email: 'primary@example.test', primary: true, verified: true },
          ]),
          { status: 200 }
        )
      }
      if (href.includes('api.github.com/user')) {
        // Conta com e-mail privado: /user não devolve o campo.
        return new Response(JSON.stringify({ id: 7, login: 'privateuser' }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${href}`)
    }) as unknown as typeof fetch

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?code=abc123',
    })

    expect(res.statusCode).toBe(302)
    const setCookie = res.headers['set-cookie']
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie
    const tokenMatch = cookieHeader?.match(/gitorch_session=([^;]+)/)
    const decoded = jwt.decode(tokenMatch![1]) as Record<string, unknown>
    expect(decoded['email']).toBe('primary@example.test')
  })

  it('returns a clean error instead of crashing when /user/emails responds with a non-array body (e.g. rate limit)', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.includes('github.com/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gh_raw_token' }), { status: 200 })
      }
      if (href.includes('api.github.com/user/emails')) {
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), {
          status: 403,
        })
      }
      if (href.includes('api.github.com/user')) {
        return new Response(JSON.stringify({ id: 7, login: 'privateuser' }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${href}`)
    }) as unknown as typeof fetch

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?code=abc123',
    })

    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('e-mail') })
    expect(userUpsert).not.toHaveBeenCalled()
  })

  it('rejects the login with a clean error when no email can be resolved at all (no public email, empty/unverified emails list)', async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.includes('github.com/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gh_raw_token' }), { status: 200 })
      }
      if (href.includes('api.github.com/user/emails')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (href.includes('api.github.com/user')) {
        return new Response(JSON.stringify({ id: 7, login: 'privateuser' }), { status: 200 })
      }
      throw new Error(`unexpected fetch ${href}`)
    }) as unknown as typeof fetch

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/callback?code=abc123',
    })

    // Sem essa checagem, o login "sucedia" (cookie setado, redirect 302) mas
    // sem User/EngineConnection persistidos — o cliente cai direto num 401
    // silencioso no primeiro /api/v1/github/repos, sem explicação nenhuma.
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ error: expect.stringContaining('e-mail') })
    expect(userUpsert).not.toHaveBeenCalled()
    expect(connectGitHubToken).not.toHaveBeenCalled()
    expect(res.headers['set-cookie']).toBeUndefined()
  })
})

describe('GET /api/v1/auth/me', () => {
  let app: ReturnType<typeof Fastify>
  const JWT_SECRET = 'test-secret-key-that-is-at-least-32-characters-long'

  beforeEach(async () => {
    process.env['GITHUB_CLIENT_ID'] = 'test-client-id'
    process.env['GITHUB_CLIENT_SECRET'] = 'test-client-secret'
    process.env['FRONTEND_URL'] = 'https://app.example.test'
    resetEnvCache()

    app = Fastify()
    await app.register(fastifyCookie)
    await app.register(rateLimit)
    // Hook global real — /api/v1/auth/me deve exigir sessão como qualquer
    // rota protegida, não reimplementar a checagem.
    await app.register(authPlugin)
    app.decorate('engineConnections', {} as unknown as EngineConnectionService)
    await authRoutes(app)
    await app.ready()
  })

  it('returns the authenticated user from the session cookie', async () => {
    const token = jwt.sign(
      { userId: '42', wingId: 'octocat', email: 'octocat@example.test' },
      JWT_SECRET
    )
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { gitorch_session: token },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ authenticated: true, userId: '42', wingId: 'octocat' })
  })

  it('returns 401 when there is no session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' })
    expect(res.statusCode).toBe(401)
  })
})
