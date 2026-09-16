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
})
