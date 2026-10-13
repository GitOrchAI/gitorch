import { describe, it, expect } from 'vitest'
import { buscarAtualizacao, textoDaAtualizacao } from './painel-atualizacao'
import { ROTAS } from './painel-api'

const fetchQueRetorna = (status: number, body: unknown): typeof fetch =>
  (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch

describe('textoDaAtualizacao', () => {
  it('trava ligada: diz desde que horas a atualização está em andamento', () => {
    const texto = textoDaAtualizacao(
      { ligada: true, desde: '2030-01-01T10:05:00.000Z' },
      { fusoHorario: 'UTC' }
    )
    expect(texto).toBe(
      'Atualização em andamento desde 10:05. Trabalho novo começa assim que terminar.'
    )
  })

  it('trava desligada: nenhuma faixa', () => {
    expect(textoDaAtualizacao({ ligada: false, desde: null })).toBeNull()
  })

  it('sem resposta: nenhuma faixa (não inventa atualização)', () => {
    expect(textoDaAtualizacao(null)).toBeNull()
  })

  it('ligada mas sem hora válida: a faixa aparece sem inventar a hora', () => {
    expect(textoDaAtualizacao({ ligada: true, desde: null })).toBe(
      'Atualização em andamento. Trabalho novo começa assim que terminar.'
    )
    expect(textoDaAtualizacao({ ligada: true, desde: 'lixo' })).toBe(
      'Atualização em andamento. Trabalho novo começa assim que terminar.'
    )
  })
})

describe('buscarAtualizacao', () => {
  it('lê a rota autenticada do painel', async () => {
    expect(ROTAS.atualizacao).toBe('/api/v1/painel/atualizacao')
    const r = await buscarAtualizacao({
      fetchImpl: fetchQueRetorna(200, { ligada: true, desde: '2030-01-01T10:05:00.000Z' }),
    })
    expect(r).toEqual({ ligada: true, desde: '2030-01-01T10:05:00.000Z' })
  })

  it('erro ou corpo malformado vira null', async () => {
    expect(await buscarAtualizacao({ fetchImpl: fetchQueRetorna(500, {}) })).toBeNull()
    expect(await buscarAtualizacao({ fetchImpl: fetchQueRetorna(200, { x: 1 }) })).toBeNull()
  })
})
