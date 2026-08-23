import { describe, expect, it, vi } from 'vitest'
import { listarSessoesJules } from './jules-client.js'

// A varredura de reconciliação só existe se o produto souber PERGUNTAR ao
// fornecedor o que está ativo. `GET /sessions?pageSize=N` foi confirmado
// disparando contra a API de verdade em 21/08/2026 — não lendo documentação:
// devolve `sessions[]` com `name`, `state`, `createTime`, `archived` e
// `sourceContext.source`, mais `nextPageToken` quando há mais páginas.
//
// A paginação tem teste próprio porque foi ela que escondeu o tamanho do
// vazamento: a primeira consulta manual mostrou "algumas" sessões ativas, e só
// ao paginar apareceram as dezoito.

function resposta(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('listarSessoesJules', () => {
  it('lê nome, arquivamento e data de nascimento de cada sessão', async () => {
    const impl = vi.fn(async () =>
      resposta({
        sessions: [
          { name: 'sessions/1', state: 'IN_PROGRESS', createTime: '2026-08-15T16:24:07Z' },
          {
            name: 'sessions/2',
            state: 'PAUSED',
            archived: true,
            createTime: '2026-08-16T00:02:28Z',
          },
        ],
      })
    )

    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      fetchImpl: impl as unknown as typeof fetch,
    })

    expect(lista).toEqual([
      { sessionName: 'sessions/1', archived: false, criadaEm: '2026-08-15T16:24:07Z' },
      { sessionName: 'sessions/2', archived: true, criadaEm: '2026-08-16T00:02:28Z' },
    ])
  })

  it('PAGINA até o fim — parar na primeira página esconderia o vazamento', async () => {
    const urls: string[] = []
    const impl = vi.fn(async (url: string) => {
      urls.push(url)
      if (!url.includes('pageToken=')) {
        return resposta({ sessions: [{ name: 'sessions/a' }], nextPageToken: 'proxima' })
      }
      return resposta({ sessions: [{ name: 'sessions/b' }] })
    })

    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      fetchImpl: impl as unknown as typeof fetch,
    })

    expect(lista?.map((s) => s.sessionName)).toEqual(['sessions/a', 'sessions/b'])
    expect(urls[1]).toContain('pageToken=proxima')
  })

  it('tem teto de páginas: token repetido não vira laço infinito', async () => {
    // O fornecedor devolvendo sempre o mesmo token prenderia a vigília para
    // sempre. O teto é a guarda; devolver o que já foi lido é melhor que
    // travar o processo inteiro.
    const impl = vi.fn(async () =>
      resposta({ sessions: [{ name: 'sessions/eterna' }], nextPageToken: 'sempre-a-mesma' })
    )

    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      fetchImpl: impl as unknown as typeof fetch,
    })

    expect(impl.mock.calls.length).toBeLessThanOrEqual(20)
    expect(lista?.length).toBeGreaterThan(0)
  })

  it('cursor repetido NÃO duplica páginas — dez cópias gastariam o teto da varredura', async () => {
    // Achado das lentes: o teto de páginas parava o laço mas não impedia que a
    // MESMA página fosse lida vinte vezes. Rio abaixo isso é grave — a
    // reconciliação arquiva no máximo dez por varredura, e dez cópias de uma
    // sessão devolveriam UMA vaga alegando ter encontrado vinte.
    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      fetchImpl: (async () =>
        resposta({
          sessions: [{ name: 'sessions/unica' }],
          nextPageToken: 'sempre-a-mesma',
        })) as unknown as typeof fetch,
    })
    expect(lista).toEqual([{ sessionName: 'sessions/unica', archived: false, criadaEm: null }])
  })

  it('a mesma sessão em duas páginas entra uma vez só', async () => {
    let pagina = 0
    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      fetchImpl: (async () => {
        pagina += 1
        return pagina === 1
          ? resposta({ sessions: [{ name: 'sessions/x' }], nextPageToken: 'p2' })
          : resposta({ sessions: [{ name: 'sessions/x' }, { name: 'sessions/y' }] })
      }) as unknown as typeof fetch,
    })
    expect(lista?.map((s) => s.sessionName)).toEqual(['sessions/x', 'sessions/y'])
  })

  it('recusa do fornecedor devolve null e avisa — NUNCA lista vazia', async () => {
    // A distinção é o ponto: lista vazia significa "não há nada ativo lá fora",
    // e a varredura não faria nada. `null` significa "não consegui perguntar".
    // Confundir os dois faria a vigília concluir que o fornecedor está limpo
    // toda vez que a rede caísse.
    const avisos: string[] = []
    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      fetchImpl: (async () => resposta({ erro: 'x' }, 500)) as unknown as typeof fetch,
      onWarn: (m) => avisos.push(m),
    })

    expect(lista).toBeNull()
    expect(avisos.some((m) => m.includes('500'))).toBe(true)
  })

  it('rede fora do ar também devolve null, sem lançar', async () => {
    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      fetchImpl: (async () => {
        throw new Error('sem rede')
      }) as unknown as typeof fetch,
    })
    expect(lista).toBeNull()
  })

  it('sem credencial não tenta nada e devolve null', async () => {
    const impl = vi.fn()
    const lista = await listarSessoesJules({ fetchImpl: impl as unknown as typeof fetch })
    expect(lista).toBeNull()
    expect(impl).not.toHaveBeenCalled()
  })

  it('sessão sem nome é descartada em vez de virar entrada quebrada', async () => {
    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      fetchImpl: (async () =>
        resposta({
          sessions: [{ state: 'IN_PROGRESS' }, { name: 'sessions/ok' }],
        })) as unknown as typeof fetch,
    })
    expect(lista?.map((s) => s.sessionName)).toEqual(['sessions/ok'])
  })
})

describe('o teto de páginas depois da medição de 22/08', () => {
  it('lê muito além das 20 páginas antigas, que a produção já estourou', async () => {
    // A produção bateu o teto antigo na PRIMEIRA varredura: "parou no teto de
    // 20 páginas; seguindo com as 2000 já lidas". Truncar deixa a
    // reconciliação cega para o que está além — ela não erra, só nunca fica
    // sabendo.
    //
    // CORREÇÃO (23/08): a versão anterior deste comentário dizia que arquivar
    // não remove a sessão da listagem. Está errado — ela encolhe exatamente
    // pelo tanto arquivado (1982, 1972, 1962, dez por rodada). O que sustenta
    // o teto maior é outra coisa: a leitura ficou PRESA em 2000 por várias
    // rodadas antes de cair, e ficar presa no teto é a assinatura de que o
    // total real era maior que ele.
    let pagina = 0
    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      pageSize: 1,
      fetchImpl: (async () => {
        pagina += 1
        const corpo: Record<string, unknown> = { sessions: [{ name: `sessions/${pagina}` }] }
        if (pagina < 60) corpo['nextPageToken'] = `p${pagina + 1}`
        return resposta(corpo)
      }) as unknown as typeof fetch,
    })
    expect(lista).toHaveLength(60)
  })

  it('mas o teto CONTINUA existindo — cursor defeituoso não prende a vigília', async () => {
    let pagina = 0
    const lista = await listarSessoesJules({
      apiKey: 'chave-de-teste',
      fetchImpl: (async () => {
        pagina += 1
        return resposta({ sessions: [{ name: `sessions/${pagina}` }], nextPageToken: `p${pagina}` })
      }) as unknown as typeof fetch,
    })
    expect(pagina).toBeLessThanOrEqual(100)
    expect(lista).not.toBeNull()
  })
})
