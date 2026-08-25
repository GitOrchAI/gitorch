import { describe, it, expect } from 'vitest'
import {
  ambientesDeclaradosPeloProjeto,
  ambientesQueValem,
  JANELA_DA_ENTREGA_RECENTE_MS,
  projetoDeclarouOndePublica,
  tarefasComEntregaMesclada,
} from './ambiente-declarado.js'

const AGORA = new Date('2026-08-25T18:00:00Z')
const HORA = 60 * 60 * 1000

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

describe('ambientesQueValem', () => {
  it('a declaração FILTRA o que existe de verdade, nunca inventa', () => {
    const r = ambientesQueValem({
      declarados: ['jardimdaspatinhas'],
      reaisDoRepositorio: ['jardimdaspatinhas', 'jardimdaspatinhas-staging', 'copilot'],
    })
    expect(r.ambientes).toEqual(['jardimdaspatinhas'])
  })

  // Nome errado calado foi o que produziu as 992 recusas. Quem chama precisa
  // poder avisar em vez de sumir com o problema.
  it('nome declarado que não existe volta separado, para virar aviso', () => {
    const r = ambientesQueValem({
      declarados: ['producao', 'nao-existe'],
      reaisDoRepositorio: ['producao', 'staging'],
    })
    expect(r.ambientes).toEqual(['producao'])
    expect(r.naoEncontrados).toEqual(['nao-existe'])
  })

  // O risco que a revisão levantou: declarar só o staging esconderia a
  // produção. O produto não pode calar sobre isso.
  it('ambiente real que ficou fora da declaração é reportado', () => {
    const r = ambientesQueValem({
      declarados: ['staging'],
      reaisDoRepositorio: ['staging', 'production'],
    })
    expect(r.ambientes).toEqual(['staging'])
    expect(r.naoDeclarados).toContain('production')
  })

  it('nada declarado existe: devolve vazio, para o chamador cair na descoberta', () => {
    const r = ambientesQueValem({
      declarados: ['nome-errado'],
      reaisDoRepositorio: ['producao'],
    })
    expect(r.ambientes).toEqual([])
    expect(r.naoEncontrados).toEqual(['nome-errado'])
  })

  it('repositório sem ambiente nenhum não quebra', () => {
    expect(ambientesQueValem({ declarados: ['x'], reaisDoRepositorio: [] }).ambientes).toEqual([])
  })
})

describe('tarefasComEntregaMesclada', () => {
  // O caso real: a #110 recebeu DOIS pull requests mesclados porque a issue
  // não fechava e o SM a delegava de novo.
  it('barra a tarefa cuja entrega foi mesclada há pouco', () => {
    const entregues = tarefasComEntregaMesclada(
      [
        { issueNumber: 110, mergeCommitSha: 'abc123', updatedAt: new Date(AGORA.getTime() - HORA) },
        { issueNumber: 3789, mergeCommitSha: null, updatedAt: AGORA },
      ],
      AGORA
    )
    expect(entregues.has(110)).toBe(true)
    expect(entregues.has(3789)).toBe(false)
  })

  // O REQUISITO EXPLÍCITO DO DONO, e a primeira versão o quebrava: ela barrava
  // para sempre, então uma issue reaberta de verdade nunca mais seria
  // candidata. A janela devolve a issue ao trabalho.
  it('issue REABERTA depois da janela volta a poder ser delegada', () => {
    const entregaAntiga = [
      {
        issueNumber: 110,
        mergeCommitSha: 'abc123',
        updatedAt: new Date(AGORA.getTime() - JANELA_DA_ENTREGA_RECENTE_MS - HORA),
      },
    ]
    expect(tarefasComEntregaMesclada(entregaAntiga, AGORA).has(110)).toBe(false)
  })

  it('exatamente na janela ainda barra — o corte é depois, não em cima', () => {
    const noLimite = [
      {
        issueNumber: 110,
        mergeCommitSha: 'abc',
        updatedAt: new Date(AGORA.getTime() - JANELA_DA_ENTREGA_RECENTE_MS),
      },
    ]
    expect(tarefasComEntregaMesclada(noLimite, AGORA).has(110)).toBe(true)
  })

  it('duas entregas da mesma tarefa contam uma vez só', () => {
    const entregues = tarefasComEntregaMesclada(
      [
        { issueNumber: 110, mergeCommitSha: 'primeiro', updatedAt: AGORA },
        { issueNumber: 110, mergeCommitSha: 'segundo', updatedAt: AGORA },
      ],
      AGORA
    )
    expect(entregues.size).toBe(1)
  })

  // Barrar sem saber a data prenderia a issue para sempre — o defeito a evitar.
  it('sem data não barra', () => {
    expect(tarefasComEntregaMesclada([{ issueNumber: 1, mergeCommitSha: 'abc' }], AGORA).size).toBe(
      0
    )
    expect(
      tarefasComEntregaMesclada(
        [{ issueNumber: 1, mergeCommitSha: 'abc', updatedAt: new Date('nada') }],
        AGORA
      ).size
    ).toBe(0)
  })

  it('data no futuro é "acabou de acontecer", e barra', () => {
    const futuro = [
      { issueNumber: 1, mergeCommitSha: 'abc', updatedAt: new Date(AGORA.getTime() + HORA) },
    ]
    expect(tarefasComEntregaMesclada(futuro, AGORA).has(1)).toBe(true)
  })

  it.each([
    ['nulo', null],
    ['ausente', undefined],
    ['em branco', '   '],
    ['vazio', ''],
  ])('commit %s não conta como entregue', (_nome, sha) => {
    expect(
      tarefasComEntregaMesclada([{ issueNumber: 1, mergeCommitSha: sha, updatedAt: AGORA }], AGORA)
        .size
    ).toBe(0)
  })

  it('lista vazia não quebra', () => {
    expect(tarefasComEntregaMesclada([], AGORA).size).toBe(0)
  })
})
