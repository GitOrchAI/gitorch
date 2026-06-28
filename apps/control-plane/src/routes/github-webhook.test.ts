import { test, expect, describe, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
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
    app.addHook('onRequest', async (req: any) => {
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

    // Test with matching signature based on mock secret 'test-secret'
    const crypto = require('crypto')
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
})
