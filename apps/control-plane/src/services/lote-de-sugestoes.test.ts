import { describe, it, expect } from 'vitest'
import {
  montarLoteDeSugestoes,
  resolverAvalDoLote,
  TETO_PADRAO_DO_LOTE,
  ACAO_DA_CATEGORIA,
  type AchadoDeDiagnostico,
  type ResultadoDoDiagnostico,
} from './lote-de-sugestoes.js'

function achado(over: Partial<AchadoDeDiagnostico> = {}): AchadoDeDiagnostico {
  return {
    issue: 1,
    categoria: 'ja_resolvido',
    motivo: 'o código já resolve isto',
    ...over,
  }
}

describe('ACAO_DA_CATEGORIA — cada categoria vira UMA ação, honesta sobre o que existe', () => {
  it('ja_resolvido propõe fechar', () => {
    expect(ACAO_DA_CATEGORIA['ja_resolvido']).toBe('fechar')
  })
  it('repetido propõe juntar (fechar como duplicata)', () => {
    expect(ACAO_DA_CATEGORIA['repetido']).toBe('juntar')
  })
  // "quebrar" não existe: diagnostico-de-issues.ts não tem lógica de dividir
  // issue nenhuma — não fabricamos uma ação de escrita que não tem base. As
  // três categorias sem ação de escrita concreta viram sinal para o dono ler,
  // nunca uma escrita silenciosa.
  it('parado, risco e vago sinalizam — sem escrita proposta', () => {
    expect(ACAO_DA_CATEGORIA['parado']).toBe('sinalizar')
    expect(ACAO_DA_CATEGORIA['risco']).toBe('sinalizar')
    expect(ACAO_DA_CATEGORIA['vago']).toBe('sinalizar')
  })
})

describe('montarLoteDeSugestoes — junta os achados numa lista única, com o motivo de cada um', () => {
  it('cada achado vira um item do lote com categoria, ação e motivo visíveis', () => {
    const resultado: ResultadoDoDiagnostico = {
      achados: [
        achado({ issue: 10, categoria: 'ja_resolvido', motivo: 'commit abc123 já corrige' }),
        achado({
          issue: 11,
          categoria: 'repetido',
          motivo: '80% de sobreposição com a issue #5',
          evidencia: 'issue #5',
        }),
      ],
    }
    const lote = montarLoteDeSugestoes(resultado)
    expect(lote.itens).toEqual([
      {
        issue: 10,
        categoria: 'ja_resolvido',
        acao: 'fechar',
        motivo: 'commit abc123 já corrige',
        evidencia: undefined,
        duplicadaDe: undefined,
      },
      {
        issue: 11,
        categoria: 'repetido',
        acao: 'juntar',
        motivo: '80% de sobreposição com a issue #5',
        evidencia: 'issue #5',
        duplicadaDe: 5,
      },
    ])
    expect(lote.totalDeAchados).toBe(2)
    expect(lote.foraDoTeto).toBe(0)
  })

  it('sem achado nenhum, o lote vem vazio — nunca lança, nunca inventa item', () => {
    const lote = montarLoteDeSugestoes({ achados: [] })
    expect(lote.itens).toEqual([])
    expect(lote.totalDeAchados).toBe(0)
    expect(lote.foraDoTeto).toBe(0)
  })

  it('extrai o número da issue original de "duplicada de" a partir da evidência de repetido', () => {
    const lote = montarLoteDeSugestoes({
      achados: [achado({ issue: 99, categoria: 'repetido', evidencia: 'issue #42' })],
    })
    expect(lote.itens[0]?.duplicadaDe).toBe(42)
  })

  it('evidência em formato inesperado não lança — duplicadaDe fica undefined', () => {
    const lote = montarLoteDeSugestoes({
      achados: [achado({ issue: 99, categoria: 'repetido', evidencia: 'formato estranho' })],
    })
    expect(lote.itens[0]?.duplicadaDe).toBeUndefined()
  })

  // A LEI DO TETO (L3-T23 já custou caro): lote grande demais cansa, mas
  // truncar em silêncio é pior — quem aprova "tudo" precisa saber que não é
  // tudo mesmo.
  describe('teto do lote — nunca trunca em silêncio', () => {
    it('teto default é 25, documentado e estável', () => {
      expect(TETO_PADRAO_DO_LOTE).toBe(25)
    })

    it('lote menor que o teto: passa inteiro, foraDoTeto é 0', () => {
      const achados = Array.from({ length: 10 }, (_, i) => achado({ issue: i + 1 }))
      const lote = montarLoteDeSugestoes({ achados }, { teto: 25 })
      expect(lote.itens).toHaveLength(10)
      expect(lote.foraDoTeto).toBe(0)
      expect(lote.totalDeAchados).toBe(10)
    })

    it('lote maior que o teto: corta no teto e DIZ quantos ficaram de fora', () => {
      const achados = Array.from({ length: 36 }, (_, i) => achado({ issue: i + 1 }))
      const lote = montarLoteDeSugestoes({ achados }, { teto: 25 })
      expect(lote.itens).toHaveLength(25)
      expect(lote.foraDoTeto).toBe(11)
      expect(lote.totalDeAchados).toBe(36)
    })

    it('teto customizado é respeitado', () => {
      const achados = Array.from({ length: 5 }, (_, i) => achado({ issue: i + 1 }))
      const lote = montarLoteDeSugestoes({ achados }, { teto: 3 })
      expect(lote.itens).toHaveLength(3)
      expect(lote.foraDoTeto).toBe(2)
    })
  })
})

describe('resolverAvalDoLote — um aval só: tudo, nada, ou item a item', () => {
  const lote = montarLoteDeSugestoes({
    achados: [
      achado({ issue: 1, categoria: 'ja_resolvido' }),
      achado({ issue: 2, categoria: 'repetido', evidencia: 'issue #1' }),
      achado({ issue: 3, categoria: 'risco' }),
    ],
  })

  it('aprovar_tudo: todo item vira aprovado', () => {
    const r = resolverAvalDoLote(lote, { modo: 'aprovar_tudo' })
    expect(r.map((i) => [i.issue, i.decisao])).toEqual([
      [1, 'aprovado'],
      [2, 'aprovado'],
      [3, 'aprovado'],
    ])
  })

  it('recusar_tudo: todo item vira recusado — nada é aplicado', () => {
    const r = resolverAvalDoLote(lote, { modo: 'recusar_tudo' })
    expect(r.every((i) => i.decisao === 'recusado')).toBe(true)
  })

  it('por_item: cada issue segue a decisão explícita', () => {
    const r = resolverAvalDoLote(lote, {
      modo: 'por_item',
      porItem: { 1: 'aprovado', 2: 'recusado', 3: 'aprovado' },
    })
    expect(r.map((i) => [i.issue, i.decisao])).toEqual([
      [1, 'aprovado'],
      [2, 'recusado'],
      [3, 'aprovado'],
    ])
  })

  // Falha fechada: item que o dono não tocou no modo item-a-item nunca vira
  // aplicado por omissão — mesma lição do "default vazio que mente" que já
  // derrubou a esteira. Silêncio é recusa, nunca aprovação.
  it('por_item: item OMITIDO do mapa vem recusado, nunca aprovado por omissão', () => {
    const r = resolverAvalDoLote(lote, { modo: 'por_item', porItem: { 1: 'aprovado' } })
    expect(r.find((i) => i.issue === 2)?.decisao).toBe('recusado')
    expect(r.find((i) => i.issue === 3)?.decisao).toBe('recusado')
  })

  it('por_item sem porItem nenhum: tudo recusado, nunca lança', () => {
    const r = resolverAvalDoLote(lote, { modo: 'por_item' })
    expect(r.every((i) => i.decisao === 'recusado')).toBe(true)
  })
})
