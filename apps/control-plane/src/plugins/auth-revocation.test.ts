import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isGuestRevoked, clearRevokedGuests } from './security.js'
import {
  isGuestRevoked as isSpendGuardGuestRevoked,
  clearRevokedGuests as clearSpendGuardGuests,
} from '../lib/spend-guard.js'
import {
  isGuestCredentialRevoked,
  clearRevokedGuestCredentials,
} from '../lib/credential-archive.js'
import Fastify from 'fastify'
import { authPlugin } from './auth.js'
import { prisma } from './prisma.js'

vi.mock('../lib/entitlements.js', () => ({
  generateProjectInvitation: vi.fn(),
  validateProjectInvitation: vi.fn(),
}))

vi.mock('./prisma.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prisma.js')>()
  return {
    ...actual,
    prisma: {
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      project: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
      },
      apiKey: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
    },
  }
})

describe('Auth Guest Revocation and Profile Endpoints', () => {
  beforeEach(() => {
    clearRevokedGuests()
    clearSpendGuardGuests()
    clearRevokedGuestCredentials()
    vi.clearAllMocks()
  })

  it('revoke endpoint sets all flags correctly for project owner', async () => {
    const app = Fastify()

    app.decorateRequest('user', undefined)
    app.addHook('preHandler', async (request) => {
      request.user = { id: 'admin1', wingId: 'wing1', email: 'admin@b.com' }
    })

    await app.register(authPlugin)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({ userId: 'admin1' } as any)

    const response = await app.inject({
      method: 'POST',
      url: '/projects/proj1/guests/guest_user_123/revoke',
      payload: { reason: 'No longer needed' },
    })

    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.payload)).toEqual({ success: true })

    expect(isGuestRevoked('guest_user_123')).toBe(true)
    expect(isSpendGuardGuestRevoked('guest_user_123')).toBe(true)
    expect(isGuestCredentialRevoked('guest_user_123')).toBe(true)
  })

  it('revoke endpoint rejects if not project owner', async () => {
    const app = Fastify()

    app.decorateRequest('user', undefined)
    app.addHook('preHandler', async (request) => {
      request.user = { id: 'admin1', wingId: 'wing1', email: 'admin@b.com' }
    })

    await app.register(authPlugin)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(prisma.project.findUnique).mockResolvedValueOnce({ userId: 'anotherUser' } as any)

    const response = await app.inject({
      method: 'POST',
      url: '/projects/proj1/guests/guest_user_123/revoke',
      payload: { reason: 'No longer needed' },
    })

    expect(response.statusCode).toBe(401)

    expect(isGuestRevoked('guest_user_123')).toBe(false)
  })

  it('PUT /guests/profile updates the user', async () => {
    const app = Fastify()

    app.decorateRequest('user', undefined)
    app.addHook('preHandler', async (request) => {
      request.user = { id: 'guest123', wingId: 'wing1', email: 'guest@b.com' }
    })

    await app.register(authPlugin)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(prisma.user.update).mockResolvedValueOnce({ id: 'guest123', name: 'New Name' } as any)

    const response = await app.inject({
      method: 'PUT',
      url: '/guests/profile',
      payload: { name: 'New Name', email: 'a@b.com' },
    })

    expect(response.statusCode).toBe(200)
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'guest123' },
      data: { name: 'New Name', email: 'a@b.com' },
    })
  })
})
