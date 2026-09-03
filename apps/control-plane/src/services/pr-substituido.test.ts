import { describe, it, expect, vi } from 'vitest'
import {
  deveFecharComoSubstituido,
  marcadorDePrSubstituido,
  fecharPrsSubstituidos,
  type DepsDeSubstituicaoDePr,
} from './pr-substituido.js'

// L4-T5, item 3 — "uma vez": mesmo com fila e retomada consertadas, a esteira
// pode nascer um PR novo para uma issue que já tem outro PR do dev aberto
// (retomada falhou, ou uma corrida qualquer). Medido: issue #3884 do Jardim,
// PRs #3907 (31/08) e #3917 (02/09) da MESMA task, os dois abertos ao mesmo
// tempo. O ANTIGO fecha, nunca o novo — o mais recente tem a chance real de
// ser o trabalho mais atualizado.

describe('marcadorDePrSubstituido / deveFecharComoSubstituido', () => {
  it('null (não deu para ler o PR) → nunca fecha', () => {
    expect(deveFecharComoSubstituido(null)).toBe(false)
  })

  it('PR já fechado → nada a fazer', () => {
    expect(deveFecharComoSubstituido({ aberto: false, ehDoDev: true })).toBe(false)
  })

  it('PR de GENTE, mesmo aberto → nunca fecha (a lei: só administra o que encomendou)', () => {
    expect(deveFecharComoSubstituido({ aberto: true, ehDoDev: false })).toBe(false)
  })

  it('PR do dev, aberto → fecha', () => {
    expect(deveFecharComoSubstituido({ aberto: true, ehDoDev: true })).toBe(true)
  })
})

function depsFake(over: Partial<DepsDeSubstituicaoDePr> = {}) {
  const comentarEFechar = vi.fn(
    async (_args: { numeroDoPr: number; comentario: string }) => undefined
  )
  const comentariosDoPr = vi.fn(async () => [] as string[])
  const deps: DepsDeSubstituicaoDePr = {
    candidatosDaMesmaIssue: async () => [],
    lerPr: async () => null,
    comentariosDoPr,
    comentarEFechar,
    onInfo: () => undefined,
    onWarn: () => undefined,
    ...over,
  }
  return { deps, comentarEFechar, comentariosDoPr }
}

describe('fecharPrsSubstituidos', () => {
  it('sem candidatos → não faz nada', async () => {
    const { deps, comentarEFechar } = depsFake()
    const r = await fecharPrsSubstituidos({ issueNumber: 3884, numeroDoNovoPr: 3917 }, deps)
    expect(r).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('candidato aberto e do dev → comenta e fecha, marcador levado no comentário', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [3907],
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
    })
    const r = await fecharPrsSubstituidos({ issueNumber: 3884, numeroDoNovoPr: 3917 }, deps)
    expect(r).toEqual([3907])
    expect(comentarEFechar).toHaveBeenCalledWith(
      expect.objectContaining({
        numeroDoPr: 3907,
        comentario: expect.stringContaining('Substituído por #3917'),
      })
    )
    const chamada = comentarEFechar.mock.calls[0]![0] as { comentario: string }
    expect(chamada.comentario).toContain(marcadorDePrSubstituido(3917))
  })

  it('já foi marcado como substituído por este mesmo PR → idempotente, não repete', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [3907],
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
      comentariosDoPr: async () => [`Substituído por #3917.\n\n${marcadorDePrSubstituido(3917)}`],
    })
    const r = await fecharPrsSubstituidos({ issueNumber: 3884, numeroDoNovoPr: 3917 }, deps)
    expect(r).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('candidato é PR de gente → nunca toca', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [99],
      lerPr: async () => ({ aberto: true, ehDoDev: false }),
    })
    const r = await fecharPrsSubstituidos({ issueNumber: 74, numeroDoNovoPr: 100 }, deps)
    expect(r).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('candidato já fechado → nada a fazer', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [3907],
      lerPr: async () => ({ aberto: false, ehDoDev: true }),
    })
    const r = await fecharPrsSubstituidos({ issueNumber: 3884, numeroDoNovoPr: 3917 }, deps)
    expect(r).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('lerPr falha para um candidato → não impede os outros', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [1, 2],
      lerPr: async (n) => {
        if (n === 1) throw new Error('boom')
        return { aberto: true, ehDoDev: true }
      },
    })
    const r = await fecharPrsSubstituidos({ issueNumber: 10, numeroDoNovoPr: 3 }, deps)
    expect(r).toEqual([2])
    expect(comentarEFechar).toHaveBeenCalledTimes(1)
  })

  it('vários candidatos abertos do dev → fecha todos, nunca o novo', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [10, 20],
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
    })
    const r = await fecharPrsSubstituidos({ issueNumber: 5, numeroDoNovoPr: 30 }, deps)
    expect(r.sort()).toEqual([10, 20])
    expect(comentarEFechar).toHaveBeenCalledTimes(2)
  })
})
