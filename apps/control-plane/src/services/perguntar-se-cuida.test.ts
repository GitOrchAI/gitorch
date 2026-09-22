import { describe, it, expect } from 'vitest'
import {
  dedupKeyDeCuidaDestePedido,
  parseDedupKeyDeCuidaDestePedido,
  montarPerguntaSeCuida,
  OPCOES_DE_CUIDA_DESTE_PEDIDO,
} from './perguntar-se-cuida.js'

describe('dedupKeyDeCuidaDestePedido / parse', () => {
  it('roda-trip', () => {
    const chave = dedupKeyDeCuidaDestePedido('dono/repo', 42)
    expect(parseDedupKeyDeCuidaDestePedido(chave)).toEqual({
      repository: 'dono/repo',
      numeroDoPr: 42,
    })
  })
})

describe('montarPerguntaSeCuida', () => {
  it('monta as 3 opções objetivas + escrever', () => {
    const pergunta = montarPerguntaSeCuida({
      numeroDoPr: 42,
      repository: 'dono/repo',
      origem: 'assistente',
      contexto: { ciclo: null, entrega: null, decisoes: [], lacunas: [] },
    })
    expect(pergunta.options.map((o) => o.value)).toEqual([
      'cuidar-sempre',
      'cuidar-uma-vez',
      'nao-cuidar',
      '__gitorch_free_text__',
    ])
    expect(pergunta.options).toHaveLength(OPCOES_DE_CUIDA_DESTE_PEDIDO.length + 1)
  })
})
