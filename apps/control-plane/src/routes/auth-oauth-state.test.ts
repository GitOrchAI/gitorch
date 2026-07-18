import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import jwt from 'jsonwebtoken'
import { resetEnvCache, getEnv } from '../config/env.js'
import { authRoutes } from './auth.js'
import type { EngineConnectionService } from '../services/engine-connection.js'

/**
 * O login do GitHub tinha dois defeitos que, juntos, impediam QUALQUER pessoa de
 * completar o wizard quando ele não era aberto pela URL fixa do FRONTEND_URL:
 *
 * 1. Não havia `state` no fluxo OAuth (brecha de CSRF).
 * 2. O retorno pós-login era fixo no FRONTEND_URL. Quem abrisse o wizard pela
 *    origem same-origin (o front servido pela própria API) era jogado para fora
 *    dela no meio do login — e o cookie de sessão, que nasce no domínio da API,
 *    ficava órfão em relação à origem onde o wizard rodava. Resultado prático:
 *    /auth/me devolvia 401 para sempre e o cadastro morria no passo 2.
 */
describe('OAuth: state assinado + retorno para a origem de quem entrou', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch

  const SAME_ORIGIN = 'https://api.example.test'
  const PAGES = 'https://pages.example.test'

  beforeEach(async () => {
    process.env['GITHUB_CLIENT_ID'] = 'test-client-id'
    process.env['GITHUB_CLIENT_SECRET'] = 'test-client-secret'
    process.env['FRONTEND_URL'] = PAGES
    process.env['GITORCH_PUBLIC_URL'] = SAME_ORIGIN
    process.env['CORS_ORIGIN'] = `${PAGES},${SAME_ORIGIN}`
    resetEnvCache()

    app = Fastify()
    await app.register(fastifyCookie)
    app.decorate('engineConnections', {
      connectGitHubToken: vi.fn().mockResolvedValue({ status: 'connected' }),
    } as unknown as EngineConnectionService)
    app.decorate('prisma', {
      user: {
        upsert: vi.fn().mockResolvedValue({
          id: 'user_1',
          email: 'quem@example.test',
          githubLogin: 'quem',
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await authRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
    resetEnvCache()
    delete process.env['GITORCH_PUBLIC_URL']
    delete process.env['CORS_ORIGIN']
  })

  const mockGitHub = (): void => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.includes('github.com/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gh_token' }), { status: 200 })
      }
      if (href.includes('api.github.com/user')) {
        return new Response(
          JSON.stringify({ id: 1, login: 'quem', email: 'quem@example.test', name: 'Quem' }),
          { status: 200 }
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
  }

  const stateFrom = (location: string): string =>
    decodeURIComponent(new URL(location).searchParams.get('state') ?? '')

  it('inclui um state assinado na ida para o GitHub (antes não havia state algum)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/github' })
    const state = stateFrom(res.headers.location as string)

    expect(state).not.toBe('')
    const decoded = jwt.verify(state, getEnv().JWT_SECRET) as { returnTo: string }
    expect(decoded.returnTo).toBe(PAGES)
  })

  it('carrega no state a origem de quem entrou (same-origin) e devolve para lá', async () => {
    const ida = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github?return_to=${encodeURIComponent(SAME_ORIGIN)}`,
    })
    const state = stateFrom(ida.headers.location as string)
    expect((jwt.verify(state, getEnv().JWT_SECRET) as { returnTo: string }).returnTo).toBe(
      SAME_ORIGIN
    )

    mockGitHub()
    const volta = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
    })

    expect(volta.statusCode).toBe(302)
    expect(volta.headers.location).toBe(`${SAME_ORIGIN}/setup`)
  })

  it('recusa destino fora da allowlist — nunca vira open redirect', async () => {
    const ida = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github?return_to=${encodeURIComponent('https://evil.example.com')}`,
    })
    const state = stateFrom(ida.headers.location as string)
    expect((jwt.verify(state, getEnv().JWT_SECRET) as { returnTo: string }).returnTo).toBe(PAGES)

    mockGitHub()
    const volta = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
    })
    expect(volta.headers.location).toBe(`${PAGES}/setup`)
    expect(volta.headers.location).not.toContain('evil')
  })

  it('rejeita state adulterado/expirado (anti-CSRF)', async () => {
    mockGitHub()
    const forjado = jwt.sign({ returnTo: SAME_ORIGIN }, 'segredo-errado')
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=abc&state=${encodeURIComponent(forjado)}`,
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('state')
  })

  it('sem state, cai no FRONTEND_URL (compatibilidade com sessões já em curso)', async () => {
    mockGitHub()
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/github/callback?code=abc' })

    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe(`${PAGES}/setup`)
  })
})

/**
 * Bug real visto pelo dono (18/07): quem entrava no wizard com ?plan=pro
 * (vindo da landing) e logava com GitHub voltava do OAuth como 'free' — o
 * passo de confirmação de plano nunca sabia que a pessoa já tinha escolhido
 * pagar. O login OAuth é uma navegação de página INTEIRA (não SPA); nada em
 * memória React sobrevive. O plano precisa atravessar o mesmo round-trip que
 * o `returnTo` já atravessa: viajar assinado dentro do `state`, e voltar na
 * URL do redirect final.
 */
describe('OAuth: o plano de entrada atravessa o round-trip', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch

  const SAME_ORIGIN = 'https://api.example.test'
  const PAGES = 'https://pages.example.test'

  beforeEach(async () => {
    process.env['GITHUB_CLIENT_ID'] = 'test-client-id'
    process.env['GITHUB_CLIENT_SECRET'] = 'test-client-secret'
    process.env['FRONTEND_URL'] = PAGES
    process.env['GITORCH_PUBLIC_URL'] = SAME_ORIGIN
    process.env['CORS_ORIGIN'] = `${PAGES},${SAME_ORIGIN}`
    resetEnvCache()

    app = Fastify()
    await app.register(fastifyCookie)
    app.decorate('engineConnections', {
      connectGitHubToken: vi.fn().mockResolvedValue({ status: 'connected' }),
    } as unknown as EngineConnectionService)
    app.decorate('prisma', {
      user: {
        upsert: vi.fn().mockResolvedValue({
          id: 'user_1',
          email: 'quem@example.test',
          githubLogin: 'quem',
        }),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)
    await authRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
    resetEnvCache()
    delete process.env['GITORCH_PUBLIC_URL']
    delete process.env['CORS_ORIGIN']
  })

  const mockGitHub = (): void => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === 'string' ? url : url.toString()
      if (href.includes('github.com/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gh_token' }), { status: 200 })
      }
      if (href.includes('api.github.com/user')) {
        return new Response(
          JSON.stringify({ id: 1, login: 'quem', email: 'quem@example.test', name: 'Quem' }),
          { status: 200 }
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
  }

  const stateFrom = (location: string): string =>
    decodeURIComponent(new URL(location).searchParams.get('state') ?? '')

  it('plan=pro atravessa o round-trip: state carrega, callback devolve ?plan=pro', async () => {
    const ida = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github?return_to=${encodeURIComponent(SAME_ORIGIN)}&plan=pro`,
    })
    const state = stateFrom(ida.headers.location as string)
    expect((jwt.verify(state, getEnv().JWT_SECRET) as { plan?: string }).plan).toBe('pro')

    mockGitHub()
    const volta = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
    })

    expect(volta.statusCode).toBe(302)
    expect(volta.headers.location).toBe(`${SAME_ORIGIN}/setup?plan=pro`)
  })

  it('sem ?plan= na ida, o state não carrega plano e o redirect não ganha query nova', async () => {
    const ida = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github?return_to=${encodeURIComponent(SAME_ORIGIN)}`,
    })
    const state = stateFrom(ida.headers.location as string)
    expect((jwt.verify(state, getEnv().JWT_SECRET) as { plan?: string }).plan).toBeUndefined()

    mockGitHub()
    const volta = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
    })
    expect(volta.headers.location).toBe(`${SAME_ORIGIN}/setup`)
  })

  it('plano inválido/desconhecido na ida é IGNORADO — nunca vira um valor não reconhecido no state nem no redirect', async () => {
    const ida = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github?return_to=${encodeURIComponent(SAME_ORIGIN)}&plan=hackerman`,
    })
    const state = stateFrom(ida.headers.location as string)
    expect((jwt.verify(state, getEnv().JWT_SECRET) as { plan?: string }).plan).toBeUndefined()

    mockGitHub()
    const volta = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
    })
    expect(volta.headers.location).toBe(`${SAME_ORIGIN}/setup`)
  })

  it('os quatro planos válidos (free/solo/pro/team) atravessam igual', async () => {
    for (const plan of ['free', 'solo', 'pro', 'team']) {
      const ida = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/github?return_to=${encodeURIComponent(SAME_ORIGIN)}&plan=${plan}`,
      })
      const state = stateFrom(ida.headers.location as string)

      mockGitHub()
      const volta = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
      })
      expect(volta.headers.location).toBe(`${SAME_ORIGIN}/setup?plan=${plan}`)
    }
  })
})
