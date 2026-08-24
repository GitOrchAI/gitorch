import { describe, it, expect } from 'vitest'
import {
  decidirSobreOProjeto,
  pedidoDeDividirAEntrega,
  REPROVACOES_ATE_ESCALAR,
  type EntregaJulgada,
} from './reprovacao-que-ensina.js'

const T = new Date('2026-08-24T04:00:00Z')
const portao = (): EntregaJulgada => ({ peloPortao: true, quando: T })
const codigo = (): EntregaJulgada => ({ peloPortao: false, quando: T })

describe('pedidoDeDividirAEntrega', () => {
  // O parecer antigo dizia "approval was blocked" e mais nada. O dev procurava
  // o defeito no código dele e não achava, porque não havia.
  it('diz o motivo real e pede algo que o dev consegue fazer', () => {
    const texto = pedidoDeDividirAEntrega(3763, 9)
    expect(texto).toContain('#3763')
    expect(texto).toContain('9 arquivo')
    expect(texto).toMatch(/divida/i)
    expect(texto).toMatch(/não estou apontando defeito no código/i)
  })
})

describe('decidirSobreOProjeto', () => {
  it('uma ou duas barradas ainda é azar: segue', () => {
    expect(decidirSobreOProjeto([portao()], 'dono/r').acao).toBe('seguir')
    expect(decidirSobreOProjeto([portao(), portao()], 'dono/r').acao).toBe('seguir')
  })

  it('na terceira seguida para de redelegar e explica o que está acontecendo', () => {
    const d = decidirSobreOProjeto([portao(), portao(), portao()], 'loureng/patinhas-3d-crafts')
    expect(d.acao).toBe('escalar')
    if (d.acao !== 'escalar') throw new Error('esperava escalar')
    expect(d.seguidas).toBe(3)
    expect(d.diagnostico).toContain('loureng/patinhas-3d-crafts')
    expect(d.diagnostico).toMatch(/não é uma entrega ruim/i)
    expect(d.diagnostico).toMatch(/volta a andar/i)
  })

  // O caso real: dez seguidas em quatro dias, todas por "CI vermelho", e a
  // esteira redelegando como se cada uma fosse a primeira.
  it('conta o caso do patinhas inteiro', () => {
    const dez = Array.from({ length: 10 }, portao)
    const d = decidirSobreOProjeto(dez, 'loureng/patinhas-3d-crafts')
    if (d.acao !== 'escalar') throw new Error('esperava escalar')
    expect(d.seguidas).toBe(10)
  })

  // Uma reprovação de CÓDIGO prova que a esteira consegue julgar o mérito ali:
  // o projeto não está travado, aquela entrega é que estava ruim.
  it('reprovação de código no meio zera a conta', () => {
    expect(decidirSobreOProjeto([portao(), portao(), codigo(), portao()], 'dono/r').acao).toBe(
      'seguir'
    )
  })

  // É o caminho de volta. Sem isto o teto viraria mordaça permanente.
  it('julgamento pelo conteúdo destrava o projeto barrado', () => {
    const barrado = [portao(), portao(), portao(), portao()]
    expect(decidirSobreOProjeto(barrado, 'dono/r').acao).toBe('escalar')
    expect(decidirSobreOProjeto([codigo(), ...barrado], 'dono/r').acao).toBe('seguir')
  })

  it('projeto sem histórico nenhum segue', () => {
    expect(decidirSobreOProjeto([], 'dono/r').acao).toBe('seguir')
  })

  it('o teto é ajustável, e o padrão é três', () => {
    expect(REPROVACOES_ATE_ESCALAR).toBe(3)
    expect(decidirSobreOProjeto([portao(), portao()], 'dono/r', 2).acao).toBe('escalar')
  })
})
