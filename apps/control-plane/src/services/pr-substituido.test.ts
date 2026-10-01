import { describe, it, expect, vi } from 'vitest'
import {
  deveFecharComoSubstituido,
  novoPrPodeSubstituir,
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
    // Default: o PR novo é uma entrega de verdade contra a principal.
    lerPrNovo: async () => ({ baseRef: 'main', arquivosAlterados: 3 }),
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
    const r = await fecharPrsSubstituidos(
      { issueNumber: 3884, numeroDoNovoPr: 3917, branchPadrao: 'main' },
      deps
    )
    expect(r).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('candidato aberto e do dev → comenta e fecha, marcador levado no comentário', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [3907],
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
    })
    const r = await fecharPrsSubstituidos(
      { issueNumber: 3884, numeroDoNovoPr: 3917, branchPadrao: 'main' },
      deps
    )
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
    const r = await fecharPrsSubstituidos(
      { issueNumber: 3884, numeroDoNovoPr: 3917, branchPadrao: 'main' },
      deps
    )
    expect(r).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('candidato é PR de gente → nunca toca', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [99],
      lerPr: async () => ({ aberto: true, ehDoDev: false }),
    })
    const r = await fecharPrsSubstituidos(
      { issueNumber: 74, numeroDoNovoPr: 100, branchPadrao: 'main' },
      deps
    )
    expect(r).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('candidato já fechado → nada a fazer', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [3907],
      lerPr: async () => ({ aberto: false, ehDoDev: true }),
    })
    const r = await fecharPrsSubstituidos(
      { issueNumber: 3884, numeroDoNovoPr: 3917, branchPadrao: 'main' },
      deps
    )
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
    const r = await fecharPrsSubstituidos(
      { issueNumber: 10, numeroDoNovoPr: 3, branchPadrao: 'main' },
      deps
    )
    expect(r).toEqual([2])
    expect(comentarEFechar).toHaveBeenCalledTimes(1)
  })

  it('vários candidatos abertos do dev → fecha todos, nunca o novo', async () => {
    const { deps, comentarEFechar } = depsFake({
      candidatosDaMesmaIssue: async () => [10, 20],
      lerPr: async () => ({ aberto: true, ehDoDev: true }),
    })
    const r = await fecharPrsSubstituidos(
      { issueNumber: 5, numeroDoNovoPr: 30, branchPadrao: 'main' },
      deps
    )
    expect(r.sort()).toEqual([10, 20])
    expect(comentarEFechar).toHaveBeenCalledTimes(2)
  })
})

describe('novoPrPodeSubstituir — o PR novo só substitui se ENTREGA na principal', () => {
  it('base = principal e diff não vazio → pode', () => {
    expect(novoPrPodeSubstituir({ baseRef: 'main', arquivosAlterados: 2 }, 'main')).toBe(true)
  })

  it('base diferente da principal → não (mesclagem falsa no ramo antigo, medido em 30/09)', () => {
    expect(
      novoPrPodeSubstituir(
        { baseRef: 'fix-refactor-conflict-verification-1', arquivosAlterados: 5 },
        'main'
      )
    ).toBe(false)
  })

  it('0 arquivos → não (PR vazio não entrega nada)', () => {
    expect(novoPrPodeSubstituir({ baseRef: 'main', arquivosAlterados: 0 }, 'main')).toBe(false)
  })

  it('sinais ausentes ou ilegíveis → não (na dúvida, não fecha o antigo)', () => {
    expect(novoPrPodeSubstituir(null, 'main')).toBe(false)
    expect(novoPrPodeSubstituir({ baseRef: null, arquivosAlterados: 4 }, 'main')).toBe(false)
    expect(novoPrPodeSubstituir({ baseRef: 'main', arquivosAlterados: null }, 'main')).toBe(false)
  })

  it('compara com a principal DO PROJETO, não com "main" fixo', () => {
    expect(novoPrPodeSubstituir({ baseRef: 'develop', arquivosAlterados: 1 }, 'develop')).toBe(true)
    expect(novoPrPodeSubstituir({ baseRef: 'main', arquivosAlterados: 1 }, 'develop')).toBe(false)
  })
})

describe('fecharPrsSubstituidos — só fecha o antigo quando o NOVO entrega na principal', () => {
  const candidato = {
    candidatosDaMesmaIssue: async () => [154],
    lerPr: async () => ({ aberto: true, ehDoDev: true }),
  }
  const chamada = { issueNumber: 4044, numeroDoNovoPr: 4100, branchPadrao: 'main' }

  it('PR novo com base num ramo antigo → o antigo continua aberto', async () => {
    const { deps, comentarEFechar, comentariosDoPr } = depsFake({
      ...candidato,
      lerPrNovo: async () => ({ baseRef: 'fix/combo-audit-suggestions-1', arquivosAlterados: 7 }),
    })
    expect(await fecharPrsSubstituidos(chamada, deps)).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
    expect(comentariosDoPr).not.toHaveBeenCalled()
  })

  it('PR novo com 0 arquivos → o antigo continua aberto', async () => {
    const { deps, comentarEFechar } = depsFake({
      ...candidato,
      lerPrNovo: async () => ({ baseRef: 'main', arquivosAlterados: 0 }),
    })
    expect(await fecharPrsSubstituidos(chamada, deps)).toEqual([])
    expect(comentarEFechar).not.toHaveBeenCalled()
  })

  it('não deu para ler o PR novo (null ou erro) → o antigo continua aberto, sem lançar', async () => {
    const semLeitura = depsFake({ ...candidato, lerPrNovo: async () => null })
    expect(await fecharPrsSubstituidos(chamada, semLeitura.deps)).toEqual([])
    expect(semLeitura.comentarEFechar).not.toHaveBeenCalled()

    const comErro = depsFake({
      ...candidato,
      lerPrNovo: async () => {
        throw new Error('rede caiu')
      },
    })
    expect(await fecharPrsSubstituidos(chamada, comErro.deps)).toEqual([])
    expect(comErro.comentarEFechar).not.toHaveBeenCalled()
  })

  it('PR novo na principal com diff → fecha o antigo', async () => {
    const { deps, comentarEFechar } = depsFake(candidato)
    expect(await fecharPrsSubstituidos(chamada, deps)).toEqual([154])
    expect(comentarEFechar).toHaveBeenCalledTimes(1)
  })
})
