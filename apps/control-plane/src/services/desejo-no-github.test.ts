import { describe, expect, it, vi } from 'vitest'
import { criarIssueDeDesejo } from './desejo-no-github.js'
import { GithubExecutionError } from './github-errors.js'

// A escrita da issue de desejo no repositório do cliente. Existe como serviço
// próprio porque tem DOIS chamadores — a tela (rota HTTP) e o mensageiro — e
// duas cópias da mesma chamada acabariam divergindo em silêncio.

const ARGS = {
  repo: 'dono/loja',
  titulo: 'quero avaliação com foto',
  corpo: 'corpo do pedido',
  etiquetas: ['wishlist'],
}

describe('criarIssueDeDesejo', () => {
  it('devolve o número da issue criada', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ number: 77 }),
    })
    const r = await criarIssueDeDesejo({
      ...ARGS,
      obterToken: async () => 'segredo',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(r).toEqual({ numero: 77 })
    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('https://api.github.com/repos/dono/loja/issues')
    expect(JSON.parse(init.body)).toEqual({
      title: ARGS.titulo,
      body: ARGS.corpo,
      labels: ['wishlist'],
    })
  })

  it('sem credencial, falha antes de tocar na rede', async () => {
    const fetchImpl = vi.fn()
    await expect(
      criarIssueDeDesejo({
        ...ARGS,
        obterToken: async () => null,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toBeInstanceOf(GithubExecutionError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('GitHub recusando vira falha explícita, nunca sucesso inventado', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Resource not accessible by integration',
    })
    await expect(
      criarIssueDeDesejo({
        ...ARGS,
        obterToken: async () => 'segredo',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/403/)
  })

  it('resposta sem número não é dada como criada', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({}),
    })
    await expect(
      criarIssueDeDesejo({
        ...ARGS,
        obterToken: async () => 'segredo',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).rejects.toThrow(/número/i)
  })
})
