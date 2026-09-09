import { describe, expect, it, vi, beforeEach } from 'vitest'
import fastify, { FastifyInstance, FastifyRequest } from 'fastify'
import { authPlugin } from './auth.js'
import * as entitlements from '../lib/entitlements.js'

vi.mock('../lib/entitlements.js', async () => {
  const actual = await vi.importActual('../lib/entitlements.js')
  return {
    ...actual,
    generateProjectInvitation: vi.fn().mockResolvedValue('mocked-token'),
  }
})

describe('POST /invitations/create', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    app = fastify()
    app.decorateRequest('user', undefined)
    app.addHook('preHandler', async (request: FastifyRequest) => {
      // Mock an authenticated user if authorization header is present
      if (request.headers.authorization === 'Bearer valid') {
        request.user = { id: 'test-user-id', wingId: 'wing-id' }
      }
    })
    // But since authPlugin is mocked/real it's easier to just register the route logic directly
    // Wait, authPlugin registers the route. Let's just use it.
    await app.register(authPlugin)
  })

  it('fails if no user in context', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/invitations/create',
      payload: {
        targetProjects: ['proj1'],
        ttlDays: 7,
      },
    })
    expect(res.statusCode).toBe(401)
  })

  it('creates an invitation and returns token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/invitations/create',
      headers: { authorization: 'Bearer valid' },
      payload: {
        targetProjects: ['proj1'],
        ttlDays: 7,
      },
    })

    expect(res.statusCode).toBe(200)
    const json = res.json()
    expect(json.token).toBe('mocked-token')
    expect(entitlements.generateProjectInvitation).toHaveBeenCalled()
  })

  it('fails if targetProjects is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/invitations/create',
      headers: { authorization: 'Bearer valid' },
      payload: {
        targetProjects: [],
        ttlDays: 7,
      },
    })
    expect(res.statusCode).not.toBe(200)
  })
})
