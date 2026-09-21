import { describe, it, expect } from 'vitest'
import { decidirMergeDoDependabot } from './dependabot-auto-merge.js'

describe('decidirMergeDoDependabot', () => {
  it('política "sim" + CI verde + sem conflito: mescla', () => {
    const r = decidirMergeDoDependabot({ politica: 'sim', verificacao: 'verde', mergeable: true })
    expect(r).toEqual({
      mesclar: true,
      motivo: 'Dependabot configurado para cuidar sozinho, verificação verde',
    })
  })
  it('política "nao": nunca mescla, mesmo com CI verde', () => {
    expect(
      decidirMergeDoDependabot({ politica: 'nao', verificacao: 'verde', mergeable: true }).mesclar
    ).toBe(false)
  })
  it('política "perguntar": não mescla sozinho (a pergunta é do motor/Tarefa 3.10)', () => {
    expect(
      decidirMergeDoDependabot({ politica: 'perguntar', verificacao: 'verde', mergeable: true })
        .mesclar
    ).toBe(false)
  })
  it('CI não verde: nunca mescla, mesmo com política "sim"', () => {
    expect(
      decidirMergeDoDependabot({ politica: 'sim', verificacao: 'vermelha', mergeable: true })
        .mesclar
    ).toBe(false)
  })
  it('conflito: nunca mescla', () => {
    expect(
      decidirMergeDoDependabot({ politica: 'sim', verificacao: 'verde', mergeable: false }).mesclar
    ).toBe(false)
  })
})
