import { describe, it, expect, vi } from 'vitest'
import {
  varrerPrsDuplicadosDoDev,
  type DepsDeVarreduraDePrsDuplicados,
} from './varrer-prs-duplicados.js'
import { marcadorDePrSubstituido } from './pr-substituido.js'

// C10 (fix-up L4-T5, CSO) — caso legado ACEITO como referência: issue #3884
// do Jardim, 5 sessões e 3 pull requests (#3907, #3913, #3917) para uma task
// — mesmo com a fila (fila-de-delegacao.ts), a retomada no mesmo PR
// (retomar-pr-reprovado.ts) e o fecho-do-antigo-quando-nasce-um-novo
// (pr-substituido.ts) já corrigidos, um PR duplicado que já existia ANTES
// desses consertos fica órfão para sempre — nada varre o passado. Esta
// varredura periódica é a rede de segurança: por projeto, agrupa PRs ABERTOS
// do dev por issue e fecha todos menos o mais novo.

function sinais(aberto: boolean, ehDoDev: boolean) {
  return { aberto, ehDoDev }
}

function depsFake(
  over: Partial<DepsDeVarreduraDePrsDuplicados> & {
    mapa?: Map<number, number[]>
    sinaisPorPr?: Map<number, { aberto: boolean; ehDoDev: boolean } | null>
  } = {}
): {
  deps: DepsDeVarreduraDePrsDuplicados
  comentarEFechar: ReturnType<typeof vi.fn>
  lerPr: ReturnType<typeof vi.fn>
} {
  const mapa = over.mapa ?? new Map()
  const sinaisPorPr = over.sinaisPorPr ?? new Map()
  const lerPr = vi.fn(async (n: number) => sinaisPorPr.get(n) ?? null)
  const comentariosDoPr = vi.fn(async () => [])
  const comentarEFechar = vi.fn(async () => undefined)
  const deps: DepsDeVarreduraDePrsDuplicados = {
    issuesComPrsRegistrados: async () => mapa,
    lerPr,
    comentariosDoPr,
    comentarEFechar,
    onInfo: () => undefined,
    onWarn: () => undefined,
    ...over,
  }
  return { deps, comentarEFechar, lerPr }
}

describe('varrerPrsDuplicadosDoDev', () => {
  it('issue com 3 PRs abertos do dev termina com 1 aberto e 2 fechados com o marcador', async () => {
    const { deps, comentarEFechar } = depsFake({
      mapa: new Map([[3884, [3907, 3913, 3917]]]),
      sinaisPorPr: new Map([
        [3907, sinais(true, true)],
        [3913, sinais(true, true)],
        [3917, sinais(true, true)],
      ]),
    })
    const r = await varrerPrsDuplicadosDoDev(deps)
    expect(r).toEqual({ issuesComDuplicata: 1, fechados: 2, falhas: 0 })
    expect(comentarEFechar).toHaveBeenCalledTimes(2)
    expect(comentarEFechar).toHaveBeenCalledWith(
      expect.objectContaining({ numeroDoPr: 3907, comentario: expect.stringContaining('#3917') })
    )
    expect(comentarEFechar).toHaveBeenCalledWith(
      expect.objectContaining({ numeroDoPr: 3913, comentario: expect.stringContaining('#3917') })
    )
    // Nunca toca o mais novo.
    expect(comentarEFechar).not.toHaveBeenCalledWith(expect.objectContaining({ numeroDoPr: 3917 }))
  })

  it('issue com só 1 PR registrado → não é duplicata, nunca chama comentarEFechar', async () => {
    const { deps, comentarEFechar } = depsFake({
      mapa: new Map([[1, [10]]]),
      sinaisPorPr: new Map([[10, sinais(true, true)]]),
    })
    const r = await varrerPrsDuplicadosDoDev(deps)
    expect(r).toEqual({ issuesComDuplicata: 0, fechados: 0, falhas: 0 })
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('2 PRs registrados mas um já fechou/mesclou → não é mais duplicata (só 1 continua aberto)', async () => {
    const { deps, comentarEFechar } = depsFake({
      mapa: new Map([[3884, [3907, 3917]]]),
      sinaisPorPr: new Map([
        [3907, sinais(false, true)], // já fechado
        [3917, sinais(true, true)],
      ]),
    })
    const r = await varrerPrsDuplicadosDoDev(deps)
    expect(r).toEqual({ issuesComDuplicata: 0, fechados: 0, falhas: 0 })
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('PR de gente (não do dev) nunca fecha, mesmo aberto e na mesma issue', async () => {
    const { deps, comentarEFechar } = depsFake({
      mapa: new Map([[3884, [3907, 3917]]]),
      sinaisPorPr: new Map([
        [3907, sinais(true, false)], // aberto, mas é de humano
        [3917, sinais(true, true)],
      ]),
    })
    const r = await varrerPrsDuplicadosDoDev(deps)
    expect(r).toEqual({ issuesComDuplicata: 0, fechados: 0, falhas: 0 })
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('já tem o marcador do PR mais novo → idempotente, não comenta de novo', async () => {
    const { deps, comentarEFechar } = depsFake({
      mapa: new Map([[3884, [3907, 3917]]]),
      sinaisPorPr: new Map([
        [3907, sinais(true, true)],
        [3917, sinais(true, true)],
      ]),
      comentariosDoPr: async () => [marcadorDePrSubstituido(3917)],
    })
    const r = await varrerPrsDuplicadosDoDev(deps)
    expect(r).toEqual({ issuesComDuplicata: 1, fechados: 0, falhas: 0 })
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('falha ao fechar um candidato não impede os outros nem outras issues', async () => {
    const { deps, comentarEFechar } = depsFake({
      mapa: new Map([
        [3884, [3907, 3913, 3917]],
        [50, [500, 501]],
      ]),
      sinaisPorPr: new Map([
        [3907, sinais(true, true)],
        [3913, sinais(true, true)],
        [3917, sinais(true, true)],
        [500, sinais(true, true)],
        [501, sinais(true, true)],
      ]),
    })
    ;(deps.comentarEFechar as ReturnType<typeof vi.fn>).mockImplementation(
      async ({ numeroDoPr }: { numeroDoPr: number }) => {
        if (numeroDoPr === 3907) throw new Error('GitHub 500')
      }
    )
    const r = await varrerPrsDuplicadosDoDev(deps)
    expect(r).toEqual({ issuesComDuplicata: 2, fechados: 2, falhas: 1 })
    expect(comentarEFechar).toHaveBeenCalledTimes(3)
  })

  it('lerPr falha para um PR → tratado como não-aberto/não-nosso, nunca lança', async () => {
    const { deps, comentarEFechar } = depsFake({
      mapa: new Map([[3884, [3907, 3917]]]),
      lerPr: vi.fn(async (n: number) => {
        if (n === 3907) throw new Error('rede caiu')
        return sinais(true, true)
      }),
    })
    const r = await varrerPrsDuplicadosDoDev(deps)
    expect(r).toEqual({ issuesComDuplicata: 0, fechados: 0, falhas: 0 })
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('nenhuma issue com múltiplos PRs → tudo zero, nenhuma chamada de leitura', async () => {
    const { deps, lerPr } = depsFake({ mapa: new Map() })
    const r = await varrerPrsDuplicadosDoDev(deps)
    expect(r).toEqual({ issuesComDuplicata: 0, fechados: 0, falhas: 0 })
    expect(lerPr).not.toHaveBeenCalled()
  })

  it('PR repetido na mesma lista (dedup) não conta duas vezes', async () => {
    const { deps, comentarEFechar } = depsFake({
      mapa: new Map([[3884, [3907, 3907, 3917]]]),
      sinaisPorPr: new Map([
        [3907, sinais(true, true)],
        [3917, sinais(true, true)],
      ]),
    })
    const r = await varrerPrsDuplicadosDoDev(deps)
    expect(r).toEqual({ issuesComDuplicata: 1, fechados: 1, falhas: 0 })
    expect(comentarEFechar).toHaveBeenCalledTimes(1)
  })
})
