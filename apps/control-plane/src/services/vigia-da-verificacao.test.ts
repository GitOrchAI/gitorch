import { describe, expect, it } from 'vitest'
import { decidirSobreVerificacao, TETO_DE_ESPERA_MS } from './vigia-da-verificacao.js'

const agora = new Date('2026-08-16T12:00:00Z')

describe('decidirSobreVerificacao', () => {
  it('verde: julga agora', () => {
    const d = decidirSobreVerificacao({ estado: 'green', primeiraVezVistoPendenteEm: null, agora })
    expect(d.acao).toBe('julgar')
    expect(d.motivo).toMatch(/verde/i)
  })

  it('vermelho: julga agora (para reprovar com motivo)', () => {
    const d = decidirSobreVerificacao({ estado: 'red', primeiraVezVistoPendenteEm: null, agora })
    expect(d.acao).toBe('julgar')
    expect(d.motivo).toMatch(/vermelh/i)
  })

  it('sem verificação nenhuma: julga agora e registra a falta', () => {
    const d = decidirSobreVerificacao({
      estado: 'no checks',
      primeiraVezVistoPendenteEm: null,
      agora,
    })
    expect(d.acao).toBe('julgar')
    expect(d.motivo).toMatch(/sem verificação/i)
  })

  it('pendente e recente: espera', () => {
    const d = decidirSobreVerificacao({
      estado: 'pending',
      primeiraVezVistoPendenteEm: new Date(agora.getTime() - 5 * 60_000),
      agora,
    })
    expect(d.acao).toBe('esperar')
    expect(d.motivo).toMatch(/pending/i)
  })

  it('pendente pela primeira vez: espera e não avisa', () => {
    const d = decidirSobreVerificacao({
      estado: 'pending',
      primeiraVezVistoPendenteEm: null,
      agora,
    })
    expect(d.acao).toBe('esperar')
    expect(d.motivo).toMatch(/pending/i)
  })

  it('pendente além do teto: avisa a demora', () => {
    const d = decidirSobreVerificacao({
      estado: 'pending',
      primeiraVezVistoPendenteEm: new Date(agora.getTime() - TETO_DE_ESPERA_MS - 1),
      agora,
    })
    expect(d.acao).toBe('avisar-demora')
    expect(d.motivo).toMatch(/demora|parada/i)
  })

  it('estado desconhecido: espera, nunca julga no escuro', () => {
    const d = decidirSobreVerificacao({
      estado: 'unknown',
      primeiraVezVistoPendenteEm: null,
      agora,
    })
    expect(d.acao).toBe('esperar')
    expect(d.motivo).toMatch(/unknown/i)
  })
})
