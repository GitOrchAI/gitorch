import { describe, it, expect } from 'vitest'
import { ghJson, headersGithub } from './github-json.js'
import { GithubExecutionError } from './github-errors.js'

// R2 (fix-up L4-T2): headers + fetch-JSON da API do GitHub estavam
// duplicados em `services/proposta.ts` e `services/decisao-de-automacao.ts`
// (cada um com a própria montagem de header e checagem de `resp.ok`).
// `ghJson`/`headersGithub` são a fonte única.

describe('headersGithub', () => {
  it('monta os headers padrão sem content-type quando não há corpo', () => {
    expect(headersGithub('tok')).toEqual({
      authorization: 'token tok',
      accept: 'application/vnd.github+json',
      'user-agent': 'gitorch',
    })
  })

  it('inclui content-type quando comCorpo=true', () => {
    expect(headersGithub('tok', true)).toEqual({
      authorization: 'token tok',
      accept: 'application/vnd.github+json',
      'user-agent': 'gitorch',
      'content-type': 'application/json',
    })
  })
})

describe('ghJson', () => {
  function jsonResp(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status })
  }

  it('GET sem corpo → sem content-type, devolve o JSON', async () => {
    const chamadas: Array<{ url: string; init: RequestInit }> = []
    const impl = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      chamadas.push({ url: String(url), init: init ?? {} })
      return jsonResp({ ok: true })
    }) as typeof fetch

    const resultado = await ghJson(impl, 'tok', 'GET', 'https://api.github.com/repos/acme/api')

    expect(resultado).toEqual({ ok: true })
    expect(chamadas[0]?.url).toBe('https://api.github.com/repos/acme/api')
    const headers = chamadas[0]?.init.headers as Record<string, string>
    expect(headers['authorization']).toBe('token tok')
    expect(headers['content-type']).toBeUndefined()
    expect(chamadas[0]?.init.body).toBeUndefined()
  })

  it('POST com corpo → serializa o body e manda content-type', async () => {
    const chamadas: Array<{ init: RequestInit }> = []
    const impl = (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      chamadas.push({ init: init ?? {} })
      return jsonResp({ number: 5 })
    }) as typeof fetch

    const resultado = await ghJson(
      impl,
      'tok',
      'POST',
      'https://api.github.com/repos/acme/api/issues',
      {
        title: 't',
      }
    )

    expect(resultado).toEqual({ number: 5 })
    expect(chamadas[0]?.init.body).toBe(JSON.stringify({ title: 't' }))
    const headers = chamadas[0]?.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
  })

  it('resposta não-ok → lança GithubExecutionError com status e no máximo 150 chars do corpo, nunca o token', async () => {
    const detalheGigante = 'x'.repeat(300)
    const impl = (async () => new Response(detalheGigante, { status: 422 })) as typeof fetch

    await expect(
      ghJson(
        impl,
        'segredo-nunca-deve-aparecer',
        'POST',
        'https://api.github.com/repos/acme/api/issues',
        {
          a: 1,
        }
      )
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(GithubExecutionError)
      const msg = (err as Error).message
      expect(msg).toContain('422')
      expect(msg).not.toContain('segredo-nunca-deve-aparecer')
      expect(msg.length).toBeLessThan(300)
      return true
    })
  })

  it('corpo de resposta vazio (ex.: 204 do DELETE) → devolve {} em vez de explodir', async () => {
    const impl = (async () => new Response(null, { status: 200 })) as typeof fetch
    const resultado = await ghJson(
      impl,
      'tok',
      'DELETE',
      'https://api.github.com/repos/acme/api/labels/x'
    )
    expect(resultado).toEqual({})
  })
})
