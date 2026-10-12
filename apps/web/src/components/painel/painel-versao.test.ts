import { describe, it, expect } from 'vitest'
import { buscarVersaoNoAr, textoDaVersaoNoAr } from './painel-versao'
import { ROTAS } from './painel-api'

const fetchQueRetorna = (status: number, body: unknown): typeof fetch =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch

describe('textoDaVersaoNoAr', () => {
  it('mostra os 7 primeiros caracteres do commit e a data e hora', () => {
    const texto = textoDaVersaoNoAr({
      commit: '4cf295d273c91567263d972e042599b9d0dc25e7',
      noArDesde: '2026-01-02T03:04:05.000Z',
    })
    expect(texto).toMatch(/^Versão no ar: 4cf295d · desde \d{2}\/\d{2}\/\d{4}.*\d{2}:\d{2}$/)
  })

  it('commit desconhecido vira "não informada"', () => {
    expect(
      textoDaVersaoNoAr({ commit: 'desconhecido', noArDesde: '2026-01-02T03:04:05.000Z' })
    ).toBe('Versão no ar: não informada')
  })

  it('resposta ausente ou malformada vira "não informada", sem inventar valor', () => {
    expect(textoDaVersaoNoAr(null)).toBe('Versão no ar: não informada')
  })

  it('data inválida mostra só o commit', () => {
    expect(textoDaVersaoNoAr({ commit: 'abcdef1234', noArDesde: 'lixo' })).toBe(
      'Versão no ar: abcdef1'
    )
  })
})

describe('buscarVersaoNoAr', () => {
  it('lê a rota pública de versão', async () => {
    expect(ROTAS.versao).toBe('/api/v1/version')
    const v = await buscarVersaoNoAr({
      fetchImpl: fetchQueRetorna(200, {
        name: 'gitorch-control-plane',
        commit: 'abcdef1',
        noArDesde: '2026-01-02T03:04:05.000Z',
      }),
    })
    expect(v).toEqual({ commit: 'abcdef1', noArDesde: '2026-01-02T03:04:05.000Z' })
  })

  it('devolve null quando a rota falha ou o corpo não tem o formato esperado', async () => {
    expect(await buscarVersaoNoAr({ fetchImpl: fetchQueRetorna(500, {}) })).toBeNull()
    expect(await buscarVersaoNoAr({ fetchImpl: fetchQueRetorna(200, { commit: 7 }) })).toBeNull()
  })
})
