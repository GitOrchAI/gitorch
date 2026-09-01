import { describe, it, expect } from 'vitest'
import { linhasVisiveis, alternar, andamentoDoNo, NIVEL, type LinhaDaArvore } from './arvore-pedido'
import type { NoDaArvore } from './painel-tipos'

function no(over: Partial<NoDaArvore> = {}): NoDaArvore {
  return {
    numero: 1,
    titulo: 'Nó',
    situacao: 'andando',
    endereco: '',
    partes: { total: 0, concluidas: 0 },
    filhos: [],
    ...over,
  }
}

/** Abre TODA a árvore, uma camada de cada vez, até não sobrar nó fechado com
 *  filhos — só para os testes: a tela nunca abre tudo de largada. */
function abrirTudo(
  pedido: string | number,
  nos: readonly NoDaArvore[]
): { linhas: LinhaDaArvore[]; abertos: Set<string> } {
  let abertos = new Set<string>()
  let linhas = linhasVisiveis(pedido, nos, abertos)
  let mudou = true
  while (mudou) {
    mudou = false
    for (const l of linhas) {
      if (l.temFilhos && !abertos.has(l.chave)) {
        abertos.add(l.chave)
        mudou = true
      }
    }
    if (mudou) linhas = linhasVisiveis(pedido, nos, abertos)
  }
  return { linhas, abertos }
}

describe('linhasVisiveis', () => {
  it('sem nada aberto, mostra só o nível 0 (fases) — pedido grande não nasce todo aberto', () => {
    const nos = [no({ numero: 1, filhos: [no({ numero: 2 })] }), no({ numero: 3 })]
    const linhas = linhasVisiveis(30, nos, new Set())
    expect(linhas).toHaveLength(2)
    expect(linhas.every((l) => l.nivel === 0)).toBe(true)
  })

  it('abrir uma fase revela só os filhos DELA, sem mexer nas outras', () => {
    const nos = [no({ numero: 1, filhos: [no({ numero: 2 })] }), no({ numero: 3 })]
    const raiz = linhasVisiveis(30, nos, new Set())
    const chaveDaFase1 = raiz[0]!.chave

    const linhas = linhasVisiveis(30, nos, new Set([chaveDaFase1]))
    expect(linhas).toHaveLength(3)
    expect(linhas.map((l) => l.no.numero)).toEqual([1, 2, 3])
    expect(linhas[1]!.nivel).toBe(1)
  })

  it('CONTAGEM DE LINHAS: com tudo aberto, o total de linhas bate exatamente com o total de nós da árvore', () => {
    // 1 fase → 2 épicos → cada um com 2 features → cada uma com 3 tasks.
    // total = 1 (fase) + 2 (épicos) + 4 (features) + 12 (tasks) = 19.
    let seq = 100
    const proximo = () => seq++
    const tasks = (n: number) => Array.from({ length: n }, () => no({ numero: proximo() }))
    const features = (n: number, nTasks: number) =>
      Array.from({ length: n }, () => no({ numero: proximo(), filhos: tasks(nTasks) }))
    const epicos = (n: number, nFeatures: number, nTasks: number) =>
      Array.from({ length: n }, () =>
        no({ numero: proximo(), filhos: features(nFeatures, nTasks) })
      )
    const nos = [no({ numero: proximo(), filhos: epicos(2, 2, 3) })]

    const totalDeNos = (lista: readonly NoDaArvore[]): number =>
      lista.reduce((soma, n) => soma + 1 + totalDeNos(n.filhos), 0)

    const { linhas } = abrirTudo(30, nos)
    expect(linhas).toHaveLength(totalDeNos(nos))
    expect(linhas).toHaveLength(19)
  })

  it('CHAVE ÚNICA: duas linhas com o MESMO número, em ramos diferentes, nunca colidem — a armadilha que já desenhou 25 linhas com 17 chaves neste painel', () => {
    const nos = [
      no({ numero: 1, filhos: [no({ numero: 99, titulo: 'Task do ramo A' })] }),
      no({ numero: 2, filhos: [no({ numero: 99, titulo: 'Task do ramo B' })] }),
    ]
    const { linhas } = abrirTudo(30, nos)
    expect(linhas).toHaveLength(4)
    const chaves = linhas.map((l) => l.chave)
    expect(new Set(chaves).size).toBe(chaves.length)
  })

  it('CHAVE ÚNICA entre pedidos diferentes: o mesmo número de nó em duas árvores não colide', () => {
    const nos = [no({ numero: 5 })]
    const l30 = linhasVisiveis(30, nos, new Set())
    const l31 = linhasVisiveis(31, nos, new Set())
    expect(l30[0]!.chave).not.toBe(l31[0]!.chave)
  })

  it('CHAVE ÚNICA entre PROJETOS: dois projetos podem repetir o número do pedido — a raiz precisa do projeto junto, não só do número', () => {
    // "Todos os projetos" pendura mais de uma árvore na MESMA tabela; dois
    // repositórios diferentes numeram issues de forma independente.
    const nos = [no({ numero: 5 })]
    const doProjetoA = linhasVisiveis('gitorch#30', nos, new Set())
    const doProjetoB = linhasVisiveis('patinhas#30', nos, new Set())
    expect(doProjetoA[0]!.chave).not.toBe(doProjetoB[0]!.chave)
  })

  it('naoCarregados é o que o GitHub reporta menos o que a consulta trouxe, nunca negativo', () => {
    const nos = [
      no({ numero: 1, partes: { total: 5, concluidas: 0 }, filhos: [no({ numero: 2 })] }),
    ]
    const linhas = linhasVisiveis(30, nos, new Set())
    expect(linhas[0]!.naoCarregados).toBe(4)
  })

  it('sem filhos e sem partes.total, naoCarregados é 0 — nunca negativo', () => {
    const nos = [no({ numero: 1, partes: { total: 0, concluidas: 0 }, filhos: [] })]
    const linhas = linhasVisiveis(30, nos, new Set())
    expect(linhas[0]!.naoCarregados).toBe(0)
    expect(linhas[0]!.temFilhos).toBe(false)
  })
})

describe('alternar', () => {
  it('abre uma chave fechada', () => {
    const a = alternar(new Set(), 'x')
    expect(a.has('x')).toBe(true)
  })

  it('fecha uma chave aberta', () => {
    const a = alternar(new Set(['x']), 'x')
    expect(a.has('x')).toBe(false)
  })

  it('não muta o conjunto recebido', () => {
    const original = new Set(['x'])
    alternar(original, 'x')
    expect(original.has('x')).toBe(true)
  })
})

describe('andamentoDoNo', () => {
  it('fechado sempre diz "fechado no GitHub", mesmo com partes', () => {
    expect(andamentoDoNo(no({ situacao: 'fechado', partes: { total: 2, concluidas: 2 } }))).toBe(
      'fechado no GitHub'
    )
  })

  it('sem filhos (0 de 0) não afirma nada — null, nunca "0%" nem "sem itens"', () => {
    expect(andamentoDoNo(no({ partes: { total: 0, concluidas: 0 } }))).toBeNull()
  })

  it('com filhos, mostra quantos estão prontos', () => {
    expect(andamentoDoNo(no({ partes: { total: 3, concluidas: 1 } }))).toBe('1 de 3 prontos')
  })
})

describe('NIVEL', () => {
  it('quatro níveis, na ordem fase→épico→feature→task', () => {
    expect(NIVEL).toEqual(['Fase', 'Épico', 'Feature', 'Task'])
  })
})
