import { describe, it, expect } from 'vitest'
import { isWithinCooldown } from './notification-cooldown.js'

const MARKER = '<!-- jules-conflict-notification -->'

describe('isWithinCooldown', () => {
  it('false quando nao ha comentario de notificacao anterior', () => {
    expect(isWithinCooldown([], MARKER, 20)).toBe(false)
  })

  it('true quando o ultimo aviso foi ha menos que o cooldown (caso real do #202)', () => {
    const now = new Date('2026-07-02T08:07:08Z')
    const comments = [
      { body: `${MARKER}\n@jules resolva o conflito`, created_at: '2026-07-02T08:01:46Z' }, // 5min21s atras
    ]
    expect(isWithinCooldown(comments, MARKER, 20, now)).toBe(true)
  })

  it('false quando o ultimo aviso foi ha mais que o cooldown', () => {
    const now = new Date('2026-07-02T09:00:00Z')
    const comments = [{ body: `${MARKER}\n@jules`, created_at: '2026-07-02T08:01:46Z' }] // 58min atras
    expect(isWithinCooldown(comments, MARKER, 20, now)).toBe(false)
  })

  it('ignora comentarios sem o marcador (ex: comentario humano ou do proprio Jules)', () => {
    const now = new Date('2026-07-02T08:07:08Z')
    const comments = [
      { body: 'Jules is on it!', created_at: '2026-07-02T08:06:00Z' },
      { body: null, created_at: '2026-07-02T08:06:30Z' },
    ]
    expect(isWithinCooldown(comments, MARKER, 20, now)).toBe(false)
  })

  it('usa o comentario de notificacao MAIS RECENTE quando ha varios (evita bombardeio acumulado)', () => {
    const now = new Date('2026-07-02T08:10:00Z')
    const comments = [
      { body: `${MARKER} antigo`, created_at: '2026-07-02T07:00:00Z' },
      { body: `${MARKER} recente`, created_at: '2026-07-02T08:05:00Z' }, // 5min atras
    ]
    expect(isWithinCooldown(comments, MARKER, 20, now)).toBe(true)
  })
})
