import { describe, it, expect, vi } from 'vitest'
import { varrerRetratoDoProjeto } from './varredura-do-retrato.js'

function ghGetFake(rotas: Record<string, unknown>) {
  return vi.fn(async (caminho: string) => {
    for (const [padrao, resposta] of Object.entries(rotas)) {
      if (caminho.startsWith(padrao)) return resposta
    }
    throw new Error(`rota não mapeada no teste: ${caminho}`)
  })
}

describe('varrerRetratoDoProjeto', () => {
  it('grava a ficha de cada PR e cada issue abertos', async () => {
    const atualizados: Array<{ tipo: string; numero: number }> = []
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [{ number: 10, state: 'open', draft: false, mergeable: true }],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: undefined }],
    })
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async (args) => {
        atualizados.push({ tipo: args.tipo, numero: args.numero })
      },
    })
    expect(resumo).toEqual({ prs: 1, issues: 1, alertas: 0 })
    expect(atualizados).toContainEqual({ tipo: 'pr', numero: 10 })
    expect(atualizados).toContainEqual({ tipo: 'issue', numero: 20 })
  })

  it('issue que é na verdade um pull request (a API do GitHub mistura os dois em /issues) é ignorada aqui', async () => {
    const atualizados: Array<{ tipo: string; numero: number }> = []
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: { url: 'x' } }],
    })
    await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async (args) => {
        atualizados.push({ tipo: args.tipo, numero: args.numero })
      },
    })
    expect(atualizados).toEqual([])
  })

  it('issue #877: com backfillGrafo, tenta o backfill até o TETO por ciclo (nunca mais)', async () => {
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [
        { number: 10, state: 'open', draft: false, mergeable: true },
        { number: 11, state: 'open', draft: false, mergeable: true },
      ],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: undefined }],
    })
    // `aplicar` retorna true = de fato disparou a coleta (item não tinha
    // grafo ainda) — é isso que consome o teto, não a mera chamada.
    const aplicar = vi.fn(async () => true)
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      backfillGrafo: { aplicar, teto: 1 },
    })
    expect(resumo).toEqual({ prs: 2, issues: 1, alertas: 0 })
    expect(aplicar).toHaveBeenCalledTimes(1)
    expect(aplicar).toHaveBeenCalledWith({ tipo: 'pr', numero: 10 })
  })

  it('issue #877: itens que JÁ TÊM grafo não gastam o teto — o teto fica pra quem realmente precisa', async () => {
    // Bug real em produção (commit 4dfb2f86, ciclos 13:44 e 14:14 UTC de
    // 29/09): o contador do teto incrementava para TODO item do lote, mesmo
    // os que já tinham `vinculos` preenchido — então os 5 slots eram sempre
    // consumidos pelos itens mais recentes (já cobertos em ciclos
    // anteriores), e itens antigos sem grafo (ex.: PR #583) nunca eram
    // alcançados. Lote de 10 PRs: os 5 primeiros (1-5) já têm grafo
    // (`aplicar` retorna false = não coletou), os 5 últimos (6-10) não têm
    // (`aplicar` retorna true = coletou). Com teto=5, os 5 ÚLTIMOS devem ser
    // os que efetivamente disparam a coleta.
    const coletaram: number[] = []
    const aplicar = vi.fn(async ({ numero }: { tipo: string; numero: number }) => {
      const jaTinhaGrafo = numero <= 5
      if (jaTinhaGrafo) return false
      coletaram.push(numero)
      return true
    })
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': Array.from({ length: 10 }, (_, i) => ({
        number: i + 1,
        state: 'open',
        draft: false,
        mergeable: true,
      })),
      '/repos/dono/repo/issues?': [],
    })
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async () => {},
      backfillGrafo: { aplicar, teto: 5 },
    })
    expect(resumo).toEqual({ prs: 10, issues: 0, alertas: 0 })
    // todos os 10 itens são ao menos consultados (pra saber se já têm grafo)…
    expect(aplicar).toHaveBeenCalledTimes(10)
    // …mas só os 5 últimos (sem grafo ainda) de fato coletaram.
    expect(coletaram).toEqual([6, 7, 8, 9, 10])
  })

  it('sem backfillGrafo (como hoje): comportamento antigo preservado, nenhum backfill tentado', async () => {
    const atualizados: Array<{ tipo: string; numero: number }> = []
    const ghGet = ghGetFake({
      '/repos/dono/repo/pulls?': [{ number: 10, state: 'open', draft: false, mergeable: true }],
      '/repos/dono/repo/issues?': [{ number: 20, state: 'open', pull_request: undefined }],
    })
    const resumo = await varrerRetratoDoProjeto({
      repo: 'dono/repo',
      ghGet,
      atualizarFicha: async (args) => {
        atualizados.push({ tipo: args.tipo, numero: args.numero })
      },
    })
    expect(resumo).toEqual({ prs: 1, issues: 1, alertas: 0 })
    expect(atualizados).toContainEqual({ tipo: 'pr', numero: 10 })
    expect(atualizados).toContainEqual({ tipo: 'issue', numero: 20 })
  })
})
