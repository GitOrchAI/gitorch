import { test, expect, describe, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { setupRoutes } from './setup.js'
import { projectRoutes } from './projects.js'
import bcrypt from 'bcryptjs'

describe('Setup and Auth Integration', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await setupRoutes(app)
    await projectRoutes(app)

    // Mock authentication for setup/submit (which requires a user session)
    app.addHook('onRequest', async (req) => {
      if (req.url === '/api/v1/setup/submit') {
        // @ts-expect-error - mock user session
        req.user = { id: 'user_123', githubToken: 'gh_token' }
      }
    })

    await app.ready()
  })

  test('should create a project with bcrypt hashed API key and authenticate with it', async () => {
    let savedKeyHash = ''
    let savedPrefix = ''

    // 1. Mock Prisma for setup/submit
    app.prisma.project.findFirst = vi.fn().mockResolvedValue(null)
    app.prisma.project.create = vi.fn().mockResolvedValue({
      id: 'proj_123',
      wingId: 'owner/repo',
      name: 'repo',
      isActive: true,
    })

    app.prisma.apiKey.create = vi.fn().mockImplementation(async ({ data }) => {
      savedKeyHash = data.keyHash
      savedPrefix = data.prefix
      return { id: 'key_123', ...data }
    })

    app.prisma.mission.create = vi.fn().mockResolvedValue({})

    // 2. Call setup/submit
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/submit',
      payload: {
        repos: ['owner/repo'],
        engines: ['engine1'],
        plan: 'free',
      },
    })

    expect(setupRes.statusCode).toBe(200)
    const setupData = setupRes.json()
    const rawApiKey = setupData.projects[0].apiKey

    expect(rawApiKey).toBeDefined()
    expect(savedKeyHash).toBeDefined()
    expect(savedKeyHash.startsWith('$2a$') || savedKeyHash.startsWith('$2b$')).toBe(true)
    expect(savedPrefix).toBe(rawApiKey.substring(0, 12))

    // 3. Verify bcrypt hash
    const match = await bcrypt.compare(rawApiKey, savedKeyHash)
    expect(match).toBe(true)

    // 4. Mock Prisma for authentication
    app.prisma.apiKey.findUnique = vi.fn().mockResolvedValue({
      id: 'key_123',
      projectId: 'proj_123',
      keyHash: savedKeyHash,
      prefix: savedPrefix,
      isActive: true,
      scopes: ['read'],
      project: {
        id: 'proj_123',
        wingId: 'owner/repo',
        isActive: true,
      },
    })
    app.prisma.apiKey.update = vi.fn().mockResolvedValue({})
    app.prisma.project.findMany = vi.fn().mockResolvedValue([])
    app.prisma.project.count = vi.fn().mockResolvedValue(0)

    // 5. Call a protected endpoint with the new API key
    const authRes = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: {
        Authorization: `Bearer ${rawApiKey}`,
      },
    })

    expect(authRes.statusCode).toBe(200)
  })

  test('should support legacy SHA256 API keys', async () => {
    const rawApiKey = 'legacy_key_1234567890'
    const prefix = rawApiKey.substring(0, 12)
    // codeql [js/insufficient-password-hash] - legacy hash for testing backward compatibility
    // Hardcoded SHA256 hash of 'legacy_key_1234567890' to avoid CodeQL alert for insecure hashing in tests
    const legacyHash = '308f9e667a3435a334995af0253682150f2273d38f6ca669b5ccad8fba3fd35a'

    // Mock Prisma for authentication
    app.prisma.apiKey.findUnique = vi.fn().mockResolvedValue({
      id: 'key_legacy',
      projectId: 'proj_123',
      keyHash: legacyHash,
      prefix: prefix,
      isActive: true,
      scopes: ['read'],
      project: {
        id: 'proj_123',
        wingId: 'owner/repo',
        isActive: true,
      },
    })
    app.prisma.apiKey.update = vi.fn().mockResolvedValue({})
    app.prisma.project.findMany = vi.fn().mockResolvedValue([])
    app.prisma.project.count = vi.fn().mockResolvedValue(0)

    const authRes = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: {
        Authorization: `Bearer ${rawApiKey}`,
      },
    })

    expect(authRes.statusCode).toBe(200)
  })
})
