/** CSV de IPs → array. Vazio = SEM allowlist (obrigatório em prod atrás do
 *  Funnel: lá o peer TCP é o tailscaled local e um allowlist de loopback
 *  liberaria o mundo inteiro do limite — achado P1-1 da eng review). */
export function parseRateLimitAllowList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function getInvitationRateLimitMax(env: {
  GITORCH_AUTH_RATE_LIMIT_MAX?: string | number
  [key: string]: unknown
}): number {
  return Number(env.GITORCH_AUTH_RATE_LIMIT_MAX ?? 20)
}

export function getGuestConsumptionCostKey(guestId: string, projectId: string): string {
  return `guest_consumption:cost:${guestId}:project:${projectId}`
}

export function getGuestConsumptionTokensKey(guestId: string, projectId: string): string {
  return `guest_consumption:tokens:${guestId}:project:${projectId}`
}
