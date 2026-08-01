import { createHash } from 'node:crypto'

/** CSV de IPs → array. Vazio = SEM allowlist (obrigatório em prod atrás do
 *  Funnel: lá o peer TCP é o tailscaled local e um allowlist de loopback
 *  liberaria o mundo inteiro do limite — achado P1-1 da eng review). */
export function parseRateLimitAllowList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

const digest = (v: string): string => createHash('sha256').update(v).digest('hex').slice(0, 16)

/** Chave do limiter de auth POR SESSÃO (nunca o token cru — só hash curto):
 *  cookie de sessão > Bearer > IP. Sem isto, todos os usuários atrás do
 *  Funnel dividiam um balde único de 20/min (3 usuários simultâneos = 429). */
export function authRateLimitKey(req: {
  ip: string
  cookies?: Record<string, string | undefined>
  headers: Record<string, unknown>
}): string {
  const cookie = req.cookies?.['gitorch_session']
  if (cookie) return `sess:${digest(cookie)}`
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer '))
    return `bearer:${digest(auth.slice(7))}`
  return `ip:${req.ip}`
}
