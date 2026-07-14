import { describe, expect, it, vi } from 'vitest'
import { parseLinkView, startTelegramLink, readTelegramLink } from './telegram-link'
import type { Fetcher, HttpResponse } from './submit-flow'

// O passo 8 é o último lugar do wizard onde ainda havia uma promessa vazia: ele
// pedia o @username e não chamava backend nenhum. Agora ele mostra o estado REAL
// do vínculo — e o que estes testes travam é justamente o que não pode voltar a
// acontecer: dizer "vinculado" sem o backend ter confirmado.

const ok = (json: unknown): HttpResponse => ({ ok: true, status: 200, json: async () => json })
const fail = (status: number): HttpResponse => ({ ok: false, status, json: async () => ({}) })

const fetcherOf = (response: HttpResponse | (() => Promise<never>)): Fetcher =>
  vi.fn(async () => (typeof response === 'function' ? response() : response)) as unknown as Fetcher

const DEEP = 'https://t.me/GitOrchAI_bot?start=abc123'

describe('parseLinkView — só o backend decide o que é "vinculado"', () => {
  it('pendente com deep link', () => {
    expect(parseLinkView({ status: 'pending', deepLink: DEEP })).toEqual({
      phase: 'pending',
      deepLink: DEEP,
    })
  })

  it('vinculado', () => {
    expect(parseLinkView({ status: 'linked', deepLink: null })).toEqual({ phase: 'linked' })
  })

  it('sem vínculo', () => {
    expect(parseLinkView({ status: 'unlinked', deepLink: null })).toEqual({ phase: 'idle' })
  })

  it('status desconhecido NÃO vira sucesso (nunca ✓ por acidente)', () => {
    expect(parseLinkView({ status: 'seiládeus', deepLink: null })).toEqual({ phase: 'idle' })
    expect(parseLinkView(null)).toEqual({ phase: 'idle' })
  })

  it('pendente SEM deep link é inútil — não fica prometendo botão que não existe', () => {
    expect(parseLinkView({ status: 'pending', deepLink: null })).toEqual({ phase: 'idle' })
  })
})

describe('startTelegramLink — pede o deep link ao backend', () => {
  it('devolve o link que o cliente vai abrir no Telegram', async () => {
    const fetchImpl = fetcherOf(ok({ status: 'pending', deepLink: DEEP }))
    const state = await startTelegramLink(
      { apiBaseUrl: 'http://api.test', fallbackError: 'falhou' },
      { fetchImpl }
    )
    expect(state).toEqual({ phase: 'pending', deepLink: DEEP })
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call[0])).toBe('http://api.test/api/v1/setup/telegram/link')
    expect(call[1]).toMatchObject({ method: 'POST', credentials: 'include' })
  })

  it('já vinculado -> vinculado (reabrir o wizard não desfaz nada)', async () => {
    const state = await startTelegramLink(
      { apiBaseUrl: 'http://api.test', fallbackError: 'falhou' },
      { fetchImpl: fetcherOf(ok({ status: 'linked', deepLink: null })) }
    )
    expect(state).toEqual({ phase: 'linked' })
  })

  it('backend fora -> erro honesto, JAMAIS "vinculado"', async () => {
    const state = await startTelegramLink(
      { apiBaseUrl: 'http://api.test', fallbackError: 'não deu para conectar' },
      { fetchImpl: fetcherOf(fail(500)) }
    )
    expect(state).toEqual({ phase: 'error', message: 'não deu para conectar' })
  })

  it('rede caída -> erro honesto, JAMAIS "vinculado"', async () => {
    const state = await startTelegramLink(
      { apiBaseUrl: 'http://api.test', fallbackError: 'sem rede' },
      {
        fetchImpl: fetcherOf(async () => {
          throw new Error('offline')
        }),
      }
    )
    expect(state).toEqual({ phase: 'error', message: 'sem rede' })
  })
})

describe('readTelegramLink — o polling que espera o Start', () => {
  it('enquanto o cliente não aperta Start, continua pendente (sem ✓ inventado)', async () => {
    const state = await readTelegramLink(
      { apiBaseUrl: 'http://api.test', fallbackError: 'falhou' },
      { fetchImpl: fetcherOf(ok({ status: 'pending', deepLink: DEEP })) }
    )
    expect(state).toEqual({ phase: 'pending', deepLink: DEEP })
  })

  it('apertou Start -> o backend capturou o chat_id -> vinculado', async () => {
    const fetchImpl = fetcherOf(ok({ status: 'linked', deepLink: null }))
    const state = await readTelegramLink(
      { apiBaseUrl: 'http://api.test', fallbackError: 'falhou' },
      { fetchImpl }
    )
    expect(state).toEqual({ phase: 'linked' })
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(call[0])).toBe('http://api.test/api/v1/setup/telegram/status')
  })

  it('poll que falha não derruba a tela nem inventa vínculo: segue pendente', async () => {
    // Um 429/500 no meio do polling é ruído de rede, não uma resposta sobre o
    // vínculo. O que NÃO pode acontecer é virar "linked" — ou "erro" e assustar
    // o cliente no meio da espera.
    const state = await readTelegramLink(
      { apiBaseUrl: 'http://api.test', fallbackError: 'falhou' },
      { fetchImpl: fetcherOf(fail(429)) }
    )
    expect(state).toBeNull()
  })
})
