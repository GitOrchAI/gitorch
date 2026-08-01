/** CSV de IPs → array. Vazio = SEM allowlist (obrigatório em prod atrás do
 *  Funnel: lá o peer TCP é o tailscaled local e um allowlist de loopback
 *  liberaria o mundo inteiro do limite — achado P1-1 da eng review). */
export function parseRateLimitAllowList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
