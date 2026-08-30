import { describe, expect, it } from 'vitest'
import { decidirAvisoDeTickQuebrado } from './aviso-de-tick-quebrado.js'
import { JANELA_LIMPA } from './aviso-por-janela.js'

describe('decidirAvisoDeTickQuebrado', () => {
  it('tique falhou mas ainda não bateu o prazo: não avisa', () => {
    const inicio = new Date('2026-08-30T00:00:00Z')
    const r1 = decidirAvisoDeTickQuebrado(JANELA_LIMPA, true, inicio, 5, 'P2022: coluna não existe')
    expect(r1.mensagem).toBeNull()
    expect(r1.novoEstado.desde).toEqual(inicio)
    expect(r1.novoEstado.avisado).toBe(false)

    const r2 = decidirAvisoDeTickQuebrado(
      r1.novoEstado,
      true,
      new Date('2026-08-30T00:04:00Z'),
      5,
      'P2022: coluna não existe'
    )
    expect(r2.mensagem).toBeNull()
  })

  it('tique falha repetidamente e passa do prazo: avisa UMA vez, com o erro no corpo', () => {
    const inicio = new Date('2026-08-30T00:00:00Z')
    const estado1 = decidirAvisoDeTickQuebrado(JANELA_LIMPA, true, inicio, 5, null).novoEstado
    const noPrazo = decidirAvisoDeTickQuebrado(
      estado1,
      true,
      new Date('2026-08-30T00:05:00Z'),
      5,
      'P2022: a coluna waiting_status não existe'
    )
    expect(noPrazo.mensagem).not.toBeNull()
    expect(noPrazo.mensagem).toContain('5 min')
    expect(noPrazo.mensagem).toContain('P2022: a coluna waiting_status não existe')
    expect(noPrazo.mensagem).toContain('db-migrate.sh')
    expect(noPrazo.novoEstado.avisado).toBe(true)

    // Continua falhando na janela seguinte: não repete o aviso.
    const depoisDeAvisar = decidirAvisoDeTickQuebrado(
      noPrazo.novoEstado,
      true,
      new Date('2026-08-30T00:06:00Z'),
      5,
      'P2022: a coluna waiting_status não existe'
    )
    expect(depoisDeAvisar.mensagem).toBeNull()
    expect(depoisDeAvisar.novoEstado.avisado).toBe(true)
  })

  it('sem erro atual disponível: avisa sem a linha "Último erro"', () => {
    const inicio = new Date('2026-08-30T00:00:00Z')
    const estado1 = decidirAvisoDeTickQuebrado(JANELA_LIMPA, true, inicio, 5, null).novoEstado
    const r = decidirAvisoDeTickQuebrado(estado1, true, new Date('2026-08-30T00:05:00Z'), 5, null)
    expect(r.mensagem).not.toBeNull()
    expect(r.mensagem).not.toContain('Último erro')
  })

  it('tique volta a funcionar: limpa a janela (próxima falha é um problema novo)', () => {
    const inicio = new Date('2026-08-30T00:00:00Z')
    let estado = decidirAvisoDeTickQuebrado(JANELA_LIMPA, true, inicio, 5, null).novoEstado
    estado = decidirAvisoDeTickQuebrado(
      estado,
      true,
      new Date('2026-08-30T00:05:00Z'),
      5,
      'erro X'
    ).novoEstado
    expect(estado.avisado).toBe(true)

    const recuperado = decidirAvisoDeTickQuebrado(
      estado,
      false,
      new Date('2026-08-30T00:06:00Z'),
      5,
      null
    )
    expect(recuperado.mensagem).toBeNull()
    expect(recuperado.novoEstado).toEqual({ desde: null, avisado: false })

    // Uma nova falha depois da recuperação começa a contar do zero.
    const novaFalha = decidirAvisoDeTickQuebrado(
      recuperado.novoEstado,
      true,
      new Date('2026-08-30T00:07:00Z'),
      5,
      'erro Y'
    )
    expect(novaFalha.mensagem).toBeNull()
    expect(novaFalha.novoEstado.avisado).toBe(false)
  })
})
