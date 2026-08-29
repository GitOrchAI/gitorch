import { describe, it, expect, vi } from 'vitest'
import { analisarFalhasPendentes, type AnalisarFalhasDeps } from './analisar-falhas-pendentes.js'
import type { EntradaDaAnalise } from './analise-de-falha-do-dev.js'

function entradaFake(issueNumber: number, sessoes = 2): EntradaDaAnalise {
  return {
    issueNumber,
    tituloDaIssue: `Issue ${issueNumber}`,
    corpoDaIssue: 'corpo',
    sessoesMortas: Array.from({ length: sessoes }, (_, i) => ({
      sessionName: `sessions/${issueNumber}-${i}`,
      estado: 'FAILED',
      ultimaAtividade: 'falhou',
    })),
    comentariosDeQa: [],
  }
}

function deps(over: Partial<AnalisarFalhasDeps> & { pendentes: number[] }): {
  d: AnalisarFalhasDeps
  gravados: number[]
  marcados: number[]
} {
  const gravados: number[] = []
  const marcados: number[] = []
  const d: AnalisarFalhasDeps = {
    listarPendentes: async () => over.pendentes,
    dadosDaIssue: async (n) => entradaFake(n),
    analisar: async (e) => ({
      causaComum: `causa ${e.issueNumber}`,
      faltouNaIssue: 'faltou',
      pedidoRevisado: 'revisado',
      padraoDoJules: `padrão ${e.issueNumber}`,
    }),
    gravarAprendizado: async ({ issueNumber }) => {
      gravados.push(issueNumber)
    },
    marcarFeita: async (n) => {
      marcados.push(n)
    },
    onInfo: () => undefined,
    onWarn: () => undefined,
    ...over,
  }
  return { d, gravados, marcados }
}

describe('analisarFalhasPendentes', () => {
  it('analisa cada pendente: grava o aprendizado e marca a análise como feita', async () => {
    const { d, gravados, marcados } = deps({ pendentes: [5, 12] })
    const r = await analisarFalhasPendentes(d)
    expect(r.analisadas).toEqual([5, 12])
    expect(gravados).toEqual([5, 12])
    expect(marcados).toEqual([5, 12])
    expect(r.padroes).toEqual([
      { issueNumber: 5, padrao: 'padrão 5' },
      { issueNumber: 12, padrao: 'padrão 12' },
    ])
  })

  it('respeita o teto por passada', async () => {
    const { d, marcados } = deps({ pendentes: [1, 2, 3, 4] })
    d.teto = 2
    await analisarFalhasPendentes(d)
    expect(marcados).toEqual([1, 2])
  })

  it('menos de 2 sessões mortas legíveis → não força a análise, issue continua pendente', async () => {
    const { d, marcados } = deps({ pendentes: [7] })
    d.dadosDaIssue = async (n) => entradaFake(n, 1)
    const r = await analisarFalhasPendentes(d)
    expect(r.analisadas).toEqual([])
    expect(marcados).toEqual([])
  })

  it('uma análise que falha não trava as outras nem marca a issue', async () => {
    const { d, marcados } = deps({ pendentes: [1, 2] })
    d.analisar = vi.fn(async (e) => {
      if (e.issueNumber === 1) throw new Error('motor fora do ar')
      return {
        causaComum: 'c',
        faltouNaIssue: 'f',
        pedidoRevisado: 'r',
        padraoDoJules: 'p',
      }
    })
    const r = await analisarFalhasPendentes(d)
    expect(r.analisadas).toEqual([2])
    expect(marcados).toEqual([2]) // a #1 NÃO foi marcada → volta na próxima passada
  })
})
