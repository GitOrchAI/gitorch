import { describe, it, expect } from 'vitest'
import {
  ambientesDeclaradosPeloProjeto,
  projetoDeclarouOndePublica,
  tarefasComEntregaMesclada,
} from './ambiente-declarado.js'

describe('ambientesDeclaradosPeloProjeto', () => {
  it('lê um nome só', () => {
    expect(
      ambientesDeclaradosPeloProjeto({ ambientes: { producao: 'jardimdaspatinhas' } })
    ).toEqual(['jardimdaspatinhas'])
  })

  it('lê uma lista, para quem publica em mais de um lugar de verdade', () => {
    expect(
      ambientesDeclaradosPeloProjeto({ ambientes: { producao: ['web-prod', 'api-prod'] } })
    ).toEqual(['web-prod', 'api-prod'])
  })

  it('mantém a ordem em que foram declarados', () => {
    expect(
      ambientesDeclaradosPeloProjeto({ ambientes: { producao: ['segundo', 'primeiro'] } })
    ).toEqual(['segundo', 'primeiro'])
  })

  // Nome repetido viraria leitura repetida da mesma coisa a cada varredura.
  it('não repete o mesmo nome', () => {
    expect(
      ambientesDeclaradosPeloProjeto({ ambientes: { producao: ['prod', 'prod', 'outro'] } })
    ).toEqual(['prod', 'outro'])
  })

  it('ignora espaço em volta do nome', () => {
    expect(ambientesDeclaradosPeloProjeto({ ambientes: { producao: '  prod  ' } })).toEqual([
      'prod',
    ])
  })

  // "Não disse" é um caso a tratar, não um nome vazio para procurar no GitHub.
  it.each([
    ['sem configuração nenhuma', null],
    ['configuração vazia', {}],
    ['bloco de ambientes sem produção', { ambientes: {} }],
    ['nome em branco', { ambientes: { producao: '   ' } }],
    ['lista vazia', { ambientes: { producao: [] } }],
    ['lista só com lixo', { ambientes: { producao: [null, 42, {}] } }],
    ['tipo errado', { ambientes: { producao: 7 } }],
  ])('%s devolve vazio', (_nome, config) => {
    expect(ambientesDeclaradosPeloProjeto(config)).toEqual([])
  })

  it('aproveita o que presta numa lista misturada', () => {
    expect(
      ambientesDeclaradosPeloProjeto({ ambientes: { producao: ['prod', null, '', 'staging'] } })
    ).toEqual(['prod', 'staging'])
  })
})

describe('projetoDeclarouOndePublica', () => {
  it('distingue "não disse" de "disse"', () => {
    expect(projetoDeclarouOndePublica({ ambientes: { producao: 'prod' } })).toBe(true)
    expect(projetoDeclarouOndePublica({})).toBe(false)
    expect(projetoDeclarouOndePublica(null)).toBe(false)
  })
})

describe('tarefasComEntregaMesclada', () => {
  // O caso real: a #110 recebeu DOIS pull requests mesclados porque a issue
  // não fechava e o SM a delegava de novo.
  it('reconhece a tarefa cuja entrega já foi mesclada', () => {
    const entregues = tarefasComEntregaMesclada([
      { issueNumber: 110, mergeCommitSha: 'abc123' },
      { issueNumber: 3789, mergeCommitSha: null },
    ])
    expect(entregues.has(110)).toBe(true)
    expect(entregues.has(3789)).toBe(false)
  })

  it('duas entregas da mesma tarefa contam uma vez só', () => {
    const entregues = tarefasComEntregaMesclada([
      { issueNumber: 110, mergeCommitSha: 'sha_do_primeiro' },
      { issueNumber: 110, mergeCommitSha: 'sha_do_segundo' },
    ])
    expect(entregues.size).toBe(1)
  })

  // Campo vazio é "não mesclado" tanto quanto ausente: ele só ganha conteúdo
  // quando o merge de fato acontece.
  it.each([
    ['nulo', null],
    ['ausente', undefined],
    ['em branco', '   '],
    ['vazio', ''],
  ])('commit %s não conta como entregue', (_nome, sha) => {
    expect(tarefasComEntregaMesclada([{ issueNumber: 1, mergeCommitSha: sha }]).size).toBe(0)
  })

  it('lista vazia não quebra', () => {
    expect(tarefasComEntregaMesclada([]).size).toBe(0)
  })
})
