import { describe, it, expect } from 'vitest'
import { horasEmConstrucao } from './em-construcao.js'

describe('horasEmConstrucao', () => {
  it('rascunho: está em construção com 0 horas (não há "desde quando" para rascunho)', () => {
    expect(horasEmConstrucao({ rascunho: true, ultimoCommitEm: null, agora: new Date() })).toBe(0)
  })

  it('não rascunho, commit de 1 hora atrás: em construção há 1 hora', () => {
    const agora = new Date('2026-09-15T10:00:00Z')
    const h = horasEmConstrucao({ rascunho: false, ultimoCommitEm: '2026-09-15T09:00:00Z', agora })
    expect(h).toBe(1)
  })

  it('não rascunho, commit de mais de 48 horas atrás: não está mais em construção', () => {
    const agora = new Date('2026-09-15T10:00:00Z')
    const h = horasEmConstrucao({ rascunho: false, ultimoCommitEm: '2026-09-10T10:00:00Z', agora })
    expect(h).toBeNull()
  })

  it('sem dado de commit: não afirma construção', () => {
    expect(
      horasEmConstrucao({ rascunho: false, ultimoCommitEm: null, agora: new Date() })
    ).toBeNull()
  })
})
