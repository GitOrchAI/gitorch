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

  // L4-T8: a issue de desejo passa a pendurar no quadro do cliente assim que
  // nasce, best-effort — reusa `anexarAoQuadro` (anexar-ao-quadro.ts) com o
  // node_id que a PRÓPRIA resposta de criação já devolve (nenhum lookup extra).
  describe('anexo ao quadro (best-effort)', () => {
    function fetchQueResponde(opts: {
      issue?: { number: number; node_id?: string }
      addItemById?: () => Response | Promise<Response>
    }) {
      const chamadas: string[] = []
      const impl = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
        const u = String(url)
        chamadas.push(u)
        if (u.endsWith('/issues')) {
          return new Response(JSON.stringify(opts.issue ?? { number: 1, node_id: 'ISSUE_NODE' }), {
            status: 201,
          })
        }
        if (u.endsWith('/graphql')) {
          if (opts.addItemById) return opts.addItemById()
          return new Response(
            JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'ITEM_1' } } } }),
            { status: 200 }
          )
        }
        throw new Error(`URL inesperada no teste: ${u}`)
      })
      return { impl: impl as unknown as typeof fetch, chamadas }
    }

    it('sem `quadro` informado, nunca toca o GraphQL do board (comportamento de hoje, intocado)', async () => {
      const { impl, chamadas } = fetchQueResponde({})
      const r = await criarIssueDeDesejo({
        ...ARGS,
        obterToken: async () => 'segredo',
        fetchImpl: impl,
      })
      expect(r).toEqual({ numero: 1 })
      expect(chamadas.some((u) => u.endsWith('/graphql'))).toBe(false)
    })

    it('com `quadro`, pendura a issue recém-criada no board usando o node_id da resposta', async () => {
      const { impl, chamadas } = fetchQueResponde({ issue: { number: 42, node_id: 'ISSUE_42' } })
      const r = await criarIssueDeDesejo({
        ...ARGS,
        obterToken: async () => 'segredo',
        fetchImpl: impl,
        quadro: { projectId: 'PROJ_1' },
      })
      expect(r).toEqual({ numero: 42 })
      expect(chamadas.some((u) => u.endsWith('/graphql'))).toBe(true)
    })

    it('falha ao anexar NUNCA derruba a issue já criada — só gera warn com repo e número', async () => {
      const onWarn = vi.fn()
      const { impl } = fetchQueResponde({
        issue: { number: 88, node_id: 'ISSUE_88' },
        addItemById: () =>
          new Response(JSON.stringify({ errors: [{ message: 'boom de rede' }] }), { status: 200 }),
      })
      const r = await criarIssueDeDesejo({
        ...ARGS,
        obterToken: async () => 'segredo',
        fetchImpl: impl,
        quadro: { projectId: 'PROJ_1' },
        log: { onWarn },
      })
      expect(r).toEqual({ numero: 88 })
      expect(onWarn).toHaveBeenCalledTimes(1)
      const [mensagem] = onWarn.mock.calls[0] as [string]
      expect(mensagem).toContain('88')
      expect(mensagem).toContain(ARGS.repo)
    })

    it('resposta de criação sem node_id: não tenta anexar (não há o que passar)', async () => {
      const { impl, chamadas } = fetchQueResponde({ issue: { number: 9 } })
      const r = await criarIssueDeDesejo({
        ...ARGS,
        obterToken: async () => 'segredo',
        fetchImpl: impl,
        quadro: { projectId: 'PROJ_1' },
      })
      expect(r).toEqual({ numero: 9 })
      expect(chamadas.some((u) => u.endsWith('/graphql'))).toBe(false)
    })
  })
})
