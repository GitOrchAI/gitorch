import { createHmac } from 'node:crypto'
import { expect, test } from 'vitest'

import { GitHubWebhookVerifier, parseGitHubDeliveryHeaders } from './github-webhook'

function signature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

test('accepts a valid X-Hub-Signature-256 webhook delivery', () => {
  const body = JSON.stringify({ action: 'opened' })
  const verifier = new GitHubWebhookVerifier('webhook-secret')

  expect(verifier.verify(body, signature('webhook-secret', body))).toBe(true)
  expect(verifier.validateWebhookDelivery(body, signature('webhook-secret', body))).toEqual({
    valid: true,
    status: 200,
  })
})

test('rejects a tampered webhook delivery', () => {
  const body = JSON.stringify({ action: 'opened' })
  const verifier = new GitHubWebhookVerifier('webhook-secret')

  expect(
    verifier.verify(JSON.stringify({ action: 'closed' }), signature('webhook-secret', body))
  ).toBe(false)
  expect(
    verifier.validateWebhookDelivery(
      JSON.stringify({ action: 'closed' }),
      signature('webhook-secret', body)
    )
  ).toEqual({ valid: false, status: 401, error: 'Invalid signature' })
})

test('rejects a missing webhook delivery signature', () => {
  const body = JSON.stringify({ action: 'opened' })
  const verifier = new GitHubWebhookVerifier('webhook-secret')

  expect(verifier.validateWebhookDelivery(body, undefined)).toEqual({
    valid: false,
    status: 401,
    error: 'Missing signature',
  })
})

test('parses required GitHub delivery headers', () => {
  const headers = parseGitHubDeliveryHeaders({
    'x-github-delivery': 'delivery-1',
    'x-github-event': 'issues',
    'x-hub-signature-256': 'sha256=abc',
    'x-github-hook-id': 'hook-1',
    'user-agent': 'GitHub-Hookshot/abc',
  })

  expect(headers).toEqual({
    deliveryId: 'delivery-1',
    eventName: 'issues',
    signature256: 'sha256=abc',
    hookId: 'hook-1',
    userAgent: 'GitHub-Hookshot/abc',
    installationTargetId: undefined,
    installationTargetType: undefined,
  })
})

test('rejects missing required webhook headers', () => {
  expect(() => parseGitHubDeliveryHeaders({ 'x-github-event': 'issues' })).toThrow(
    'Missing required GitHub webhook header: x-github-delivery'
  )
})
