/**
 * Previne bombardeio de comentários `@jules`.
 *
 * Sem cooldown, todo push na main (outro PR mesclando) OU todo commit que o Jules empurra
 * dispara reanálise + um comentário `@jules` NOVO e completo, sem intervalo mínimo. Visto ao
 * vivo: o PR #202 recebeu 70 comentários em menos de 24h (vários no mesmo minuto) — o Jules
 * nunca teve uma janela estável pra terminar uma tentativa antes de ser interrompido de novo.
 * Mesmo o PR #181, que teve sucesso, recebeu 31 avisos; nos que travaram (#202, #205) o
 * bombardeio impede convergência.
 */

export interface CommentLike {
  body?: string | null
  created_at: string
}

/** Retorna true se o último comentário com `marker` foi postado há menos de `cooldownMinutes`. */
export function isWithinCooldown(
  comments: CommentLike[],
  marker: string,
  cooldownMinutes: number,
  now: Date = new Date()
): boolean {
  const notificationTimes = comments
    .filter((c) => c.body?.includes(marker))
    .map((c) => new Date(c.created_at).getTime())

  if (notificationTimes.length === 0) return false

  const lastNotifiedAt = Math.max(...notificationTimes)
  const minutesSince = (now.getTime() - lastNotifiedAt) / 60000
  return minutesSince < cooldownMinutes
}
