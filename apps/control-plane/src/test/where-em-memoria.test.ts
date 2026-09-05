import { describe, test, expect } from 'vitest'
import { casa } from './where-em-memoria.js'

// FIX-UP L4-T16: `routes/painel.ts` (GET /respostas-ao-dev) passou a filtrar
// por um campo DENTRO de uma coluna JSON (`payload: { path: ['origem'],
// equals: 'resposta-tecnica' }` — a mesma sintaxe já usada de verdade em
// plugins/scheduler.ts). O interpretador genérico deste arquivo ainda não
// sabia ler `path` — um `where` assim estourava com "operador 'path'
// desconhecido" (de propósito, ver o cabeçalho do arquivo: ignorar o que não
// entende transformaria filtro errado em teste verde). Ensinando aqui, como
// o próprio arquivo pede.
describe('casa — filtro por "path" em campo JSON (sintaxe Prisma path+equals)', () => {
  test('path desce até a chave dentro do JSON e compara com equals', () => {
    const linha = { id: '1', payload: { origem: 'resposta-tecnica', padrao: 'x' } }
    expect(casa(linha, { payload: { path: ['origem'], equals: 'resposta-tecnica' } })).toBe(true)
    expect(casa(linha, { payload: { path: ['origem'], equals: 'duvida-do-dev' } })).toBe(false)
  })

  test('chave ausente no JSON não casa com um equals de string', () => {
    const linha = { id: '2', payload: { padrao: 'x' } }
    expect(casa(linha, { payload: { path: ['origem'], equals: 'resposta-tecnica' } })).toBe(false)
  })

  test('path combina com os demais campos do where (AND implícito entre chaves)', () => {
    const linha = { id: '3', type: 'jules-learning', payload: { origem: 'resposta-tecnica' } }
    expect(
      casa(linha, {
        type: 'jules-learning',
        payload: { path: ['origem'], equals: 'resposta-tecnica' },
      })
    ).toBe(true)
    expect(
      casa(linha, {
        type: 'outro-tipo',
        payload: { path: ['origem'], equals: 'resposta-tecnica' },
      })
    ).toBe(false)
  })

  test('path aceita caminho de mais de um nível', () => {
    const linha = { id: '4', payload: { vigiaDoPr: { numeroDoPr: 42 } } }
    expect(casa(linha, { payload: { path: ['vigiaDoPr', 'numeroDoPr'], equals: 42 } })).toBe(true)
    expect(casa(linha, { payload: { path: ['vigiaDoPr', 'numeroDoPr'], equals: 7 } })).toBe(false)
  })
})
