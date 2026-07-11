import { test, expect, describe, vi, beforeEach } from 'vitest'
import Fastify, { FastifyRequest } from 'fastify'
import crypto from 'node:crypto'
import { loadEnv } from '../config/env.js'
import { registerPlugins } from '../plugins/index.js'
import { githubWebhookRoutes } from './github-webhook.js'

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
