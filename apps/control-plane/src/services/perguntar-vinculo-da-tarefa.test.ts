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
  it('monta até 2 issues candidatas como opções objetivas + "nenhuma destas" + escrever', () => {
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

  it('formato do dono: 3 objetivas + 1 aberta. Três candidatas viram duas (o Telegram recusa mais de 3 fixas)', () => {
    const pergunta = montarPerguntaSobreVinculoDaTarefa({
      numeroDoPr: 42,
      repository: 'dono/repo',
      contexto: { ciclo: null, entrega: null, decisoes: [], lacunas: [] },
      candidatas: [
        { numero: 10, titulo: 'A' },
        { numero: 11, titulo: 'B' },
        { numero: 12, titulo: 'C' },
        { numero: 13, titulo: 'D' },
      ],
    })
    const fixas = pergunta.options.filter((o) => o.value !== '__gitorch_free_text__')
    expect(fixas).toHaveLength(3)
    expect(pergunta.options).toHaveLength(4)
    expect(pergunta.options.map((o) => o.value)).toEqual([
      'vinculo-issue-10',
      'vinculo-issue-11',
      'nenhuma-destas',
      '__gitorch_free_text__',
    ])
  })

  it('título com emoji na fronteira do corte do botão não deixa substituto solto, nem o do pull request', () => {
    const emoji = '\u{1F600}'
    const titulo = `${'t'.repeat(58)}${emoji}${'u'.repeat(20)}`
    const solto = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    const pergunta = montarPerguntaSobreVinculoDaTarefa({
      numeroDoPr: 42,
      repository: 'dono/repo',
      tituloDoPr: titulo,
      contexto: { ciclo: null, entrega: null, decisoes: [], lacunas: [] },
      candidatas: [
        { numero: 10, titulo },
        { numero: 11, titulo: 'solto\uD83D' },
      ],
    })
    expect(pergunta.options[0]?.label).toBe(`#10 — ${'t'.repeat(58)}${emoji}…`)
    for (const texto of [pergunta.text, ...pergunta.options.map((o) => o.label)]) {
      expect(solto.test(texto)).toBe(false)
    }
    expect(pergunta.options[1]?.label).toBe('#11 — solto\uFFFD')
  })

  it('sem nenhuma candidata: ainda há "nenhuma destas" e a resposta livre', () => {
    const pergunta = montarPerguntaSobreVinculoDaTarefa({
      numeroDoPr: 42,
      repository: 'dono/repo',
      contexto: { ciclo: null, entrega: null, decisoes: [], lacunas: [] },
      candidatas: [],
    })
    expect(pergunta.options.map((o) => o.value)).toEqual([
      'nenhuma-destas',
      '__gitorch_free_text__',
    ])
  })

  it('o título do pull request entra no texto, para o dono saber de qual se trata', () => {
    const pergunta = montarPerguntaSobreVinculoDaTarefa({
      numeroDoPr: 590,
      repository: 'dono/repo',
      tituloDoPr: 'wishlist: add vira desejo',
      contexto: { ciclo: null, entrega: null, decisoes: [], lacunas: [] },
      candidatas: [],
    })
    expect(pergunta.text).toContain('#590')
    expect(pergunta.text).toContain('wishlist: add vira desejo')
  })

  it('título comprido de issue é cortado no botão (o botão do celular não é lugar de parágrafo)', () => {
    const pergunta = montarPerguntaSobreVinculoDaTarefa({
      numeroDoPr: 42,
      repository: 'dono/repo',
      contexto: { ciclo: null, entrega: null, decisoes: [], lacunas: [] },
      candidatas: [{ numero: 10, titulo: 'x'.repeat(300) }],
    })
    expect(pergunta.options[0]!.label.length).toBeLessThanOrEqual(80)
    expect(pergunta.options[0]!.label.startsWith('#10 — ')).toBe(true)
  })
})
