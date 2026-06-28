import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import { webhookVerifyPlugin } from './webhook-verify.js'

describe('Webhook Verify Plugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeEach(async () => {
    app = Fastify()
    await app.register(webhookVerifyPlugin)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('registers webhook verify plugin without error', async () => {
    expect(app.verifyGitHubWebhook).toBeDefined()
    expect(typeof app.verifyGitHubWebhook).toBe('function')
  })
})
