import { describe, it, expect } from 'vitest'
import { ehApenasReserva, nomeDaReserva, semAsReservas } from './reserva-de-vaga.js'

describe('reserva de vaga', () => {
  it('reconhece o nome provisório', () => {
    expect(ehApenasReserva(nomeDaReserva('proj_1', 153))).toBe(true)
  })

  it('sessão de verdade não é reserva', () => {
    expect(ehApenasReserva('sessions/12524112320054343491')).toBe(false)
    expect(ehApenasReserva(null)).toBe(false)
    expect(ehApenasReserva(undefined)).toBe(false)
  })

  // A retrospectiva conta como abandono toda linha fechada sem merge. Uma
  // reserva recusada nasce e morre em segundos sem ter trabalhado — contá-la
  // inflaria a taxa de abandono justamente porque o produto passou a recusar
  // cedo, que era o objetivo.
  it('separa reserva de trabalho real numa lista', () => {
    const linhas = [
      { sessionName: nomeDaReserva('p', 1) },
      { sessionName: 'sessions/999' },
      { sessionName: nomeDaReserva('p', 2) },
    ]
    expect(semAsReservas(linhas)).toEqual([{ sessionName: 'sessions/999' }])
  })

  it('lista sem reserva nenhuma volta inteira', () => {
    const linhas = [{ sessionName: 'sessions/1' }, { sessionName: 'sessions/2' }]
    expect(semAsReservas(linhas)).toHaveLength(2)
  })
})
