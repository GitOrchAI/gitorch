import { createHmac, timingSafeEqual } from 'node:crypto'

import type { GitHubDeliveryHeaders, GitHubWebhookEventName } from './types'

export class GitHubWebhookVerifier {
  constructor(private readonly secret: string) {
    if (secret.length === 0) {
      throw new Error('GitHub webhook secret must not be empty.')
    }
  }

  verify(body: string, signature256: string): boolean {
    if (!signature256.startsWith('sha256=')) {
      return false
    }

    const expected = `sha256=${createHmac('sha256', this.secret)
      .update(body, 'utf8')
      .digest('hex')}`
    const expectedBuffer = Buffer.from(expected, 'utf8')
    const actualBuffer = Buffer.from(signature256, 'utf8')

    return (
      expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
    )
  }
}

export function parseGitHubDeliveryHeaders(
  headers: Record<string, string | string[] | undefined>
): GitHubDeliveryHeaders {
  const normalized = normalizeHeaders(headers)

  return {
    deliveryId: requiredHeader(normalized, 'x-github-delivery'),
    eventName: requiredHeader(normalized, 'x-github-event') as GitHubWebhookEventName,
    signature256: requiredHeader(normalized, 'x-hub-signature-256'),
    hookId: normalized['x-github-hook-id'],
    userAgent: normalized['user-agent'],
    installationTargetType: normalized['x-github-hook-installation-target-type'],
    installationTargetId: normalized['x-github-hook-installation-target-id'],
  }
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .filter((entry): entry is [string, string | string[]] => entry[1] !== undefined)
      .map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? (value[0] ?? '') : value])
  )
}

function requiredHeader(headers: Record<string, string>, key: string): string {
  const value = headers[key]

  if (!value) {
    throw new Error(`Missing required GitHub webhook header: ${key}`)
  }

  return value
}
