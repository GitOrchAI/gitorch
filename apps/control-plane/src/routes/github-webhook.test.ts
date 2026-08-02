import { test, expect, describe, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import crypto from 'node:crypto'
import { loadEnv, resetEnvCache } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { githubWebhookRoutes, missionRoleForEvent } from './github-webhook.js'

describe('missionRoleForEvent', () => {
  test('acorda o QA quando check_suite conclui', () => {
    expect(missionRoleForEvent('check_suite', { action: 'completed' })).toBe('qa')
  })

  test('acorda o QA quando workflow_run conclui', () => {
    expect(missionRoleForEvent('workflow_run', { action: 'completed' })).toBe('qa')
  })

  test('não acorda nada quando check_suite ainda não concluiu', () => {
    expect(missionRoleForEvent('check_suite', { action: 'requested' })).toBeNull()
  })
})

describe('GitHub Webhook Routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await githubWebhookRoutes(app)

    // Mock the require auth plugin by manually decorating
    app.addHook('onRequest', async (req: FastifyRequest) => {
      // @ts-expect-error - mock authentication
      req.user = { wingId: 'wing_123', projectId: 'proj_456' }
      req.wingId = 'wing_123'
    })

    await app.ready()
  })

  test('POST /api/webhooks/github requires valid signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      payload: { action: 'opened' },
    })

    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('Missing signature')
  })

  test('POST /api/webhooks/github processes valid webhook', async () => {
    app.prisma.webhookDelivery.create = vi.fn().mockResolvedValue({})
    app.prisma.webhookDelivery.updateMany = vi.fn().mockResolvedValue({})
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_123', wingId: 'wing_123' })
    app.prisma.project.update = vi.fn().mockResolvedValue({})

    // Test with matching signature based on mock secret 'test-secret'
    const payloadStr = JSON.stringify({ action: 'opened', repository: { id: 123 } })
    const signature =
      'sha256=' + crypto.createHmac('sha256', 'test-secret').update(payloadStr).digest('hex')

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery_123',
      },
      payload: { action: 'opened', repository: { id: 123 } },
    })

    expect(res.statusCode).toBe(200)
    expect(res.payload).toContain('"received":true')
  })

  test('POST /api/webhooks/github resolves project by repository.full_name and backfills numeric IDs', async () => {
    app.prisma.webhookDelivery.create = vi.fn().mockResolvedValue({})
    app.prisma.webhookDelivery.updateMany = vi.fn().mockResolvedValue({})
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({
      id: 'proj_x',
      wingId: 'loureng/gitorch',
      githubInstallationId: null,
      githubRepoId: null,
    })
    app.prisma.project.update = vi.fn().mockResolvedValue({})

    const payloadStr = JSON.stringify({
      action: 'opened',
      repository: { id: 1274419899, full_name: 'loureng/gitorch' },
      issue: { labels: [{ name: 'wishlist' }] },
    })
    const signature =
      'sha256=' + crypto.createHmac('sha256', 'test-secret').update(payloadStr).digest('hex')

    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery_fullname',
      },
      payload: {
        action: 'opened',
        repository: { id: 1274419899, full_name: 'loureng/gitorch' },
        issue: { labels: [{ name: 'wishlist' }] },
      },
    })

    expect(res.statusCode).toBe(200)

    expect(app.prisma.project.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([{ wingId: 'loureng/gitorch' }]),
        }),
      })
    )

    expect(app.prisma.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'proj_x' },
        data: expect.objectContaining({ githubRepoId: 1274419899n }),
      })
    )
  })
})

// Isolado num describe próprio (achados I1/M2): request.ip via app.inject()
// sem X-Forwarded-For é '127.0.0.1' — o default de GITORCH_RATE_LIMIT_ALLOWLIST
// ('127.0.0.1,::1', ver .env.example). Antes da correção do achado M2,
// allowList comparava contra a CHAVE pós-keyGenerator (`ip:127.0.0.1`), que
// nunca batia com o array de IPs crus — a allowlist ficava inerte e todo
// request, mesmo de um IP "isento", era limitado normalmente (foi assim que
// este teste passava). Com a allowlist FUNCIONANDO de verdade, o describe
// pai deixaria de rate-limitar 127.0.0.1 — então este teste, cujo PONTO é
// provar que o limite de fato dispara, zera a allowlist pra simular
// produção atrás do Funnel (GITORCH_RATE_LIMIT_ALLOWLIST=, ver I3).
describe('GitHub Webhook Routes — rate limit (allowlist vazia, como em produção)', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    process.env['GITORCH_RATE_LIMIT_ALLOWLIST'] = ''
    resetEnvCache()

    app = Fastify()
    const env = loadEnv()
    await registerPlugins(app, env)
    await githubWebhookRoutes(app)

    app.addHook('onRequest', async (req: FastifyRequest) => {
      // @ts-expect-error - mock authentication
      req.user = { wingId: 'wing_123', projectId: 'proj_456' }
      req.wingId = 'wing_123'
    })

    await app.ready()
  })

  afterEach(() => {
    delete process.env['GITORCH_RATE_LIMIT_ALLOWLIST']
    resetEnvCache()
  })

  test('POST /api/webhooks/github is rate limited', async () => {
    app.prisma.webhookDelivery.create = vi.fn().mockResolvedValue({})
    app.prisma.webhookDelivery.updateMany = vi.fn().mockResolvedValue({})
    app.prisma.project.findFirst = vi.fn().mockResolvedValue({ id: 'proj_123', wingId: 'wing_123' })
    app.prisma.project.update = vi.fn().mockResolvedValue({})

    const payloadStr = JSON.stringify({ action: 'opened', repository: { id: 123 } })
    const signature =
      'sha256=' + crypto.createHmac('sha256', 'test-secret').update(payloadStr).digest('hex')

    // Make 100 requests (the limit)
    for (let i = 0; i < 100; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/github',
        headers: {
          'x-hub-signature-256': signature,
          'x-github-event': 'pull_request',
          'x-github-delivery': `delivery_${i}`,
        },
        payload: { action: 'opened', repository: { id: 123 } },
      })
      expect(res.statusCode).toBe(200)
    }

    // The 101st request should be rate limited (max is 100)
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/github',
      headers: {
        'x-hub-signature-256': signature,
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery_limit',
      },
      payload: { action: 'opened', repository: { id: 123 } },
    })

    // Debug: if not 429, throw with full response info
    if (res.statusCode !== 429) {
      throw new Error(
        `Expected 429 but got ${res.statusCode}\nHeaders: ${JSON.stringify(res.headers, null, 2)}\nBody: ${res.payload}`
      )
    }
    expect(res.json().message).toContain('Rate limit exceeded')
  })
})
