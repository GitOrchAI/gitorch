import { describe, it, expect } from 'vitest'
import { NAV, PLANO, TABS, telasDaFolha, tituloDaTela } from './painel-nav'

describe('painel-nav', () => {
  it('10 telas no total', () => {
    expect(PLANO).toHaveLength(10)
  })
  it('3 grupos na ordem certa', () => {
    expect(NAV.map((g) => g.g)).toEqual(['Operação', 'Recursos', 'Conta'])
  })
  it('só "decisoes" tem badge', () => {
    expect(PLANO.filter((i) => i.badge).map((i) => i.id)).toEqual(['decisoes'])
  })
  it('a barra mobile tem 4 destinos terminando em "mais"', () => {
    expect(TABS).toEqual(['visao', 'decisoes', 'pedidos', 'mais'])
  })
  it('a folha "Mais" traz as 7 telas fora dos 3 destinos fixos', () => {
    expect(telasDaFolha().map((i) => i.id)).toEqual([
      'entregas',
      'custos',
      'motores',
      'projetos',
      'regras',
      'historico',
      'config',
    ])
  })
  it('tituloDaTela cai em "Visão geral" para id desconhecido', () => {
    expect(tituloDaTela('xpto')).toBe('Visão geral')
    expect(tituloDaTela('custos')).toBe('Custos e limites')
    expect(tituloDaTela('motores')).toBe('Motores por agente')
  })
})
