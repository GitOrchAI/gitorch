import { describe, expect, test, vi } from 'vitest'
import { fetchComTeto, TIMEOUT_PADRAO_DE_CHAMADA_MS } from './fetch-com-teto.js'

// Este arquivo prova as duas metades da garantia que `fetchComTeto` existe
// para dar: (1) sem `signal` nenhum vindo do chamador, o teto sozinho já
// aborta uma chamada pendurada — a classe de defeito que travava o relógio
// inteiro (Crítico do despacho: `avisarDonoDoProjeto`/Telegram); (2) COM um
// `signal` do chamador, o teto continua valendo — a combinação, não a
// substituição, é o que impede `init?.signal ?? AbortSignal.timeout(...)`
// de apagar o teto sempre que o chamador já passa um `signal` (Minor 1).

describe('fetchComTeto', () => {
  test('sem signal do chamador: o fetch de baixo recebe um AbortSignal não abortado', async () => {
    const fetchImpl = vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
        new Response('{}')
    )
    const comTeto = fetchComTeto(fetchImpl as unknown as typeof fetch, TIMEOUT_PADRAO_DE_CHAMADA_MS)
    await comTeto('https://exemplo.invalido/x')
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.signal?.aborted).toBe(false)
  })

  test('uma chamada que só resolve quando abortada nunca fica pendurada além do teto', async () => {
    // Simula exatamente o defeito do Crítico do despacho: um fetch cujo
    // socket travou (nunca resolve nem rejeita sozinho). Sem o teto, esta
    // promise nunca se resolveria e o teste falharia por estourar o timeout
    // padrão do vitest (10s) — é a prova por mutação em ação: comentar a
    // linha do `AbortSignal.timeout` dentro de `fetchComTeto` faz este
    // teste pendurar e falhar.
    const fetchImpl = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason)
          })
        })
    )
    // Teto BEM curto só para o teste não esperar os 10s reais em produção —
    // o mecanismo é o mesmo (`AbortSignal.timeout`), só o valor muda.
    const comTeto = fetchComTeto(fetchImpl as unknown as typeof fetch, 20)
    await expect(comTeto('https://exemplo.invalido/x')).rejects.toBeDefined()
  })

  test('COM signal do chamador: o teto continua valendo (combinação, não substituição)', async () => {
    // Minor 1: `init?.signal ?? AbortSignal.timeout(...)` deixaria de criar
    // o teto sempre que o chamador já passa um `signal` — mesmo que esse
    // signal do chamador nunca seja abortado. Um controller que nunca
    // aborta representa exatamente esse caso.
    const controllerDoChamador = new AbortController()
    const fetchImpl = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason)
          })
        })
    )
    const comTeto = fetchComTeto(fetchImpl as unknown as typeof fetch, 20)
    await expect(
      comTeto('https://exemplo.invalido/x', { signal: controllerDoChamador.signal })
    ).rejects.toBeDefined()
  })

  test('o abort do PRÓPRIO chamador continua propagando (a combinação não abafa o lado do chamador)', async () => {
    const controllerDoChamador = new AbortController()
    const fetchImpl = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason)
          })
        })
    )
    // Teto longo de propósito: se o abort chegar rápido mesmo assim, só pode
    // ter vindo do controller do chamador, não do teto padrão.
    const comTeto = fetchComTeto(fetchImpl as unknown as typeof fetch, 60_000)
    const chamada = comTeto('https://exemplo.invalido/x', { signal: controllerDoChamador.signal })
    controllerDoChamador.abort(new Error('cancelado pelo chamador'))
    await expect(chamada).rejects.toThrow('cancelado pelo chamador')
  })

  test('default: sem argumentos, usa o `fetch` global e o teto padrão de 10s', () => {
    // Só prova que a assinatura por defaults não quebra — não faz uma
    // chamada de rede de verdade.
    expect(() => fetchComTeto()).not.toThrow()
  })
})
