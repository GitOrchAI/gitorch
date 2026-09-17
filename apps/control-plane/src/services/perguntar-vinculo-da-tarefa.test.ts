import { describe, it, expect } from 'vitest'
import {
  dedupKeyDeVinculoDaTarefa,
  parseDedupKeyDeVinculoDaTarefa,
  montarPerguntaSobreVinculoDaTarefa,
} from './perguntar-vinculo-da-tarefa.js'

describe('dedupKeyDeVinculoDaTarefa / parseDedupKeyDeVinculoDaTarefa', () => {
  it('roda-trip', () => {
    const chave = dedupKeyDeVinculoDaTarefa('dono/repo', 42)
    expect(parseDedupKeyDeVinculoDaTarefa(chave)).toEqual({
      repository: 'dono/repo',
      numeroDoPr: 42,
    })
  })
  it('formato desconhecido devolve null, nunca lança', () => {
    expect(parseDedupKeyDeVinculoDaTarefa('lixo')).toBeNull()
  })
})

describe('montarPerguntaSobreVinculoDaTarefa', () => {
  it('monta até 3 issues candidatas como opções objetivas + escrever', () => {
    const pergunta = montarPerguntaSobreVinculoDaTarefa({
      numeroDoPr: 42,
      repository: 'dono/repo',
      contexto: { ciclo: null, entrega: null, decisoes: [], lacunas: [] },
      candidatas: [
        { numero: 10, titulo: 'Corrigir cache' },
        { numero: 11, titulo: 'Ajustar layout' },
      ],
    })
    expect(pergunta.options.map((o) => o.value)).toEqual([
      'vinculo-issue-10',
      'vinculo-issue-11',
      'nenhuma-destas',
      '__gitorch_free_text__',
    ])
    expect(pergunta.dedupKey).toBe('vinculo-da-tarefa:dono/repo:42')
  })
})
