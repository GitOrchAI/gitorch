import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import { setupRoutes } from './setup.js'
import type { EngineConnectionService } from '../services/engine-connection.js'

describe('GET /api/v1/github/repos', () => {
  let app: ReturnType<typeof Fastify>
  const originalFetch = global.fetch
  let getRawGithubToken: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    getRawGithubToken = vi.fn().mockResolvedValue('gh_encrypted_roundtrip_token')

    app = Fastify()
    app.decorate('engineConnections', {
      getRawGithubToken,
    } as unknown as EngineConnectionService)
    // Simula o hook global de auth já tendo populado request.user (cookie ou
    // Bearer) — o token do GitHub em si NÃO vem mais daqui (spec §17.4).
    app.addHook('preHandler', async (request: FastifyRequest) => {
      request.user = { id: 'user_1', wingId: 'octocat' }
    })
    await setupRoutes(app)
    await app.ready()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('fetches repos using the token decrypted from the user vault, not the session', async () => {
    global.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          {
            id: 1,
            name: 'repo',
            full_name: 'octocat/repo',
            description: null,
            private: false,
            html_url: 'https://github.com/octocat/repo',
          },
        ]),
        { status: 200 }
      )
    }) as unknown as typeof fetch

    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })

    expect(res.statusCode).toBe(200)
    expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall).toBeDefined()
    const headers = fetchCall?.[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer gh_encrypted_roundtrip_token')
  })

  it('returns 401 when the user has no connected github token', async () => {
    getRawGithubToken.mockResolvedValue(null)
    const res = await app.inject({ method: 'GET', url: '/api/v1/github/repos' })
    expect(res.statusCode).toBe(401)
  })
})
