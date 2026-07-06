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

  beforeEach(async () => {
    process.env['GITHUB_CLIENT_ID'] = 'test-client-id'
    process.env['GITHUB_CLIENT_SECRET'] = 'test-client-secret'
    process.env['FRONTEND_URL'] = 'https://app.example.test'
    resetEnvCache()

    connectGitHubToken = vi.fn().mockResolvedValue({ status: 'connected' })

    app = Fastify()
    await app.register(fastifyCookie)
    // engineConnections é decorado pelo plugin real (engines.ts) a partir do
    // Prisma; aqui isolamos o teste da camada de dados com um double —
    // a persistência em si já tem cobertura própria em engine-connection.test.ts.
    app.decorate('engineConnections', {
      connectGitHubToken,
    } as unknown as EngineConnectionService)
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
    expect(cookieHeader).toContain('SameSite=Lax')

    const tokenMatch = cookieHeader?.match(/gitorch_session=([^;]+)/)
    expect(tokenMatch).not.toBeNull()
    const decoded = jwt.decode(tokenMatch![1]) as Record<string, unknown>
    expect(decoded.userId).toBe('42')
    expect(decoded.wingId).toBe('octocat')
    // O token do GitHub NÃO pode viajar no JWT da sessão (spec §17.4).
    expect(decoded.githubToken).toBeUndefined()

    // O token do GitHub é persistido cifrado por usuário, não no JWT.
    expect(connectGitHubToken).toHaveBeenCalledWith('42', 'gh_raw_token')
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
