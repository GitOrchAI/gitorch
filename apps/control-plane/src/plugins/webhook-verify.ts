import { FastifyPluginAsync } from 'fastify'
import { GitHubWebhookVerifier } from '@gitorch/github-sync'
import { loadEnv } from '../config/env.js'

const env = loadEnv()

export const webhookVerifyPlugin: FastifyPluginAsync = async (app) => {
  const secret = env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    throw new Error('GITHUB_WEBHOOK_SECRET is required')
  }
  const verifier = new GitHubWebhookVerifier(secret)

  app.decorate('verifyGitHubWebhook', (payload: string, signature: string) => {
    return verifier.verify(payload, signature)
  })
}
Object.assign(webhookVerifyPlugin, { [Symbol.for('skip-override')]: true })
