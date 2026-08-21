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

  it('a chamada leva prazo — GitHub travado não segura a rota para sempre', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ number: 1 }),
    })
    await criarIssueDeDesejo({
      ...ARGS,
      obterToken: async () => 'segredo',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const [, init] = fetchImpl.mock.calls[0] as [string, { signal?: AbortSignal }]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  describe('nome de repositório é conferido ANTES de a credencial sair', () => {
    // Prova do porquê: o texto do repositório vai colado numa URL que carrega
    // o token. A normalização de URL resolve o ".." e o "?" ANTES de a
    // requisição sair, então quem escolhe o texto escolhe o endereço.
    it('o endereço de fato muda quando o texto tem travessia', () => {
      expect(new URL('https://api.github.com/repos/a/b/../../../user/repos/issues').pathname).toBe(
        '/user/repos/issues'
      )
      expect(new URL('https://api.github.com/repos/../user/repos?/issues').href).toBe(
        'https://api.github.com/user/repos?/issues'
      )
    })

    const venenos = [
      'a/b/../../../user/repos',
      '../user/repos?',
      'a/b/c',
      '/b',
      'a/',
      '',
      'a b/c',
      'https://x/y',
      `dono/${'r'.repeat(300)}`,
    ]

    for (const repo of venenos) {
      it(`recusa ${JSON.stringify(repo)} sem tocar rede nem pedir credencial`, async () => {
        const fetchImpl = vi.fn()
        const obterToken = vi.fn()
        await expect(
          criarIssueDeDesejo({
            ...ARGS,
            repo,
            obterToken,
            fetchImpl: fetchImpl as unknown as typeof fetch,
          })
        ).rejects.toBeInstanceOf(GithubExecutionError)
        expect(fetchImpl).not.toHaveBeenCalled()
        expect(obterToken).not.toHaveBeenCalled()
      })
    }
  })
})
