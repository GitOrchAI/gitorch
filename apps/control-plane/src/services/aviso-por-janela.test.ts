import { describe, it, expect } from 'vitest'
import { decidirAvisoPorJanela, JANELA_LIMPA, type EstadoDaJanela } from './aviso-por-janela.js'

const t = (min: number) => new Date(2026, 7, 29, 12, 0, 0 + min * 60)

describe('decidirAvisoPorJanela', () => {
  it('problema começou agora → registra o início, não avisa', () => {
    const d = decidirAvisoPorJanela(JANELA_LIMPA, true, t(0), 20)
    expect(d.deveAvisar).toBe(false)
    expect(d.novoEstado.desde).toEqual(t(0))
    expect(d.novoEstado.avisado).toBe(false)
  })

  it('persiste 21 min sem ter avisado → avisa e marca', () => {
    const estado: EstadoDaJanela = { desde: t(0), avisado: false }
    const d = decidirAvisoPorJanela(estado, true, t(21), 20)
    expect(d.deveAvisar).toBe(true)
    expect(d.novoEstado.avisado).toBe(true)
    expect(d.minutosNoProblema).toBe(21)
  })

  it('persiste e já avisou → silêncio (nada de spam)', () => {
    const estado: EstadoDaJanela = { desde: t(0), avisado: true }
    const d = decidirAvisoPorJanela(estado, true, t(45), 20)
    expect(d.deveAvisar).toBe(false)
  })

  it('problema sumiu → limpa a marca', () => {
    const estado: EstadoDaJanela = { desde: t(0), avisado: true }
    const d = decidirAvisoPorJanela(estado, false, t(30), 20)
    expect(d.deveAvisar).toBe(false)
    expect(d.novoEstado).toEqual(JANELA_LIMPA)
  })

  it('o estado limpo devolvido é uma cópia mutável, não a constante congelada', () => {
    const d = decidirAvisoPorJanela({ desde: t(0), avisado: true }, false, t(30), 20)
    expect(d.novoEstado).not.toBe(JANELA_LIMPA)
    expect(() => {
      d.novoEstado.avisado = true
    }).not.toThrow()
    // e a constante do módulo continua intacta para a próxima chamada
    expect(JANELA_LIMPA).toEqual({ desde: null, avisado: false })
  })

  it('JANELA_LIMPA é congelada — mutação acidental não passa despercebida', () => {
    expect(Object.isFrozen(JANELA_LIMPA)).toBe(true)
  })

  it('3 ciclos cobrindo 21 min → exatamente 1 aviso', () => {
    let estado = JANELA_LIMPA
    const avisos: number[] = []
    for (const min of [0, 8, 21]) {
      const d = decidirAvisoPorJanela(estado, true, t(min), 20)
      if (d.deveAvisar) avisos.push(min)
      estado = d.novoEstado
    }
    // e mais um ciclo: continua travado, mas não avisa de novo
    const d = decidirAvisoPorJanela(estado, true, t(30), 20)
    expect(d.deveAvisar).toBe(false)
    expect(avisos).toEqual([21])
  })
})
