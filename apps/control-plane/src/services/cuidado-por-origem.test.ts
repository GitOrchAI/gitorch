import { describe, it, expect } from 'vitest'
import {
  lerCuidaPorOrigem,
  lerJanelaEmConstrucaoHoras,
  JANELA_EM_CONSTRUCAO_PADRAO_HORAS,
} from './cuidado-por-origem.js'

describe('lerCuidaPorOrigem', () => {
  it('sem configuração e sem ser o dono: tudo "perguntar", exceto dependabot "sim"', () => {
    expect(lerCuidaPorOrigem(null, false)).toEqual({
      jules: 'sim',
      assistente: 'perguntar',
      pessoa: 'perguntar',
      dependabot: 'sim',
    })
  })

  it('lê o que o cliente configurou em runtimeConfig.cuidaPorOrigem', () => {
    const runtimeConfig = {
      cuidaPorOrigem: { jules: 'nao', assistente: 'sim', pessoa: 'nao', dependabot: 'perguntar' },
    }
    expect(lerCuidaPorOrigem(runtimeConfig, false)).toEqual({
      jules: 'nao',
      assistente: 'sim',
      pessoa: 'nao',
      dependabot: 'perguntar',
    })
  })

  it('valor desconhecido em uma origem cai no padrão daquela origem, sem derrubar as outras', () => {
    const runtimeConfig = { cuidaPorOrigem: { jules: 'talvez', assistente: 'sim' } }
    expect(lerCuidaPorOrigem(runtimeConfig, false)).toEqual({
      jules: 'sim',
      assistente: 'sim',
      pessoa: 'perguntar',
      dependabot: 'sim',
    })
  })
})

describe('lerJanelaEmConstrucaoHoras', () => {
  it('padrão de 2 horas quando ninguém configurou', () => {
    expect(lerJanelaEmConstrucaoHoras(null)).toBe(JANELA_EM_CONSTRUCAO_PADRAO_HORAS)
  })
  it('lê o valor configurado', () => {
    expect(lerJanelaEmConstrucaoHoras({ janelaEmConstrucaoHoras: 6 })).toBe(6)
  })
  it('valor negativo ou não numérico cai no padrão', () => {
    expect(lerJanelaEmConstrucaoHoras({ janelaEmConstrucaoHoras: -3 })).toBe(
      JANELA_EM_CONSTRUCAO_PADRAO_HORAS
    )
    expect(lerJanelaEmConstrucaoHoras({ janelaEmConstrucaoHoras: 'seis' })).toBe(
      JANELA_EM_CONSTRUCAO_PADRAO_HORAS
    )
  })
})
