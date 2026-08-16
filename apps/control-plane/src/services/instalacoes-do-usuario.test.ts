import { describe, expect, it, vi } from 'vitest'
import {
  usuarioAdministraInstalacao,
  InstalacaoNaoVerificavelError,
} from './instalacoes-do-usuario.js'

/**
 * Este módulo é o que separa "o cliente disse" de "o GitHub confirmou". Os testes
 * abaixo prendem as duas pontas: a resposta afirmativa só sai com o id na lista
 * DELE, e qualquer forma de não-saber vira recusa — nunca liberação.
 */

/** Uma página de `GET /user/installations` com os ids informados. */
function pagina(ids: number[]): Response {
  return new Response(
    JSON.stringify({ total_count: ids.length, installations: ids.map((id) => ({ id })) }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )
}

describe('usuarioAdministraInstalacao', () => {
  it('id presente na lista do cliente: aprova', async () => {
    const fetchImpl = vi.fn(async () => pagina([10, 20, 30])) as unknown as typeof fetch

    await expect(usuarioAdministraInstalacao(20, { githubToken: 'tok', fetchImpl })).resolves.toBe(
      true
    )
  })

  it('id AUSENTE da lista do cliente: recusa (é a instalação de outra pessoa)', async () => {
    const fetchImpl = vi.fn(async () => pagina([10, 20, 30])) as unknown as typeof fetch

    await expect(
      usuarioAdministraInstalacao(424242, { githubToken: 'tok', fetchImpl })
    ).resolves.toBe(false)
  })

  it('pergunta com o token do cliente e no endpoint do usuário, não no do App', async () => {
    const fetchImpl = vi.fn(async () => pagina([7])) as unknown as typeof fetch

    await usuarioAdministraInstalacao(7, { githubToken: 'gho_do_cliente', fetchImpl })

    const chamada = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(chamada[0])).toBe('https://api.github.com/user/installations?per_page=100&page=1')
    expect((chamada[1] as { headers: Record<string, string> }).headers['Authorization']).toBe(
      'Bearer gho_do_cliente'
    )
  })

  it('percorre as páginas seguintes quando a primeira vem cheia', async () => {
    const primeira = Array.from({ length: 100 }, (_, i) => i + 1)
    // `endsWith` e não `includes`: "page=1" é prefixo de "page=10" e a segunda
    // página nunca chegaria a ser respondida.
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('page=1') ? pagina(primeira) : pagina([999])
    ) as unknown as typeof fetch

    await expect(usuarioAdministraInstalacao(999, { githubToken: 'tok', fetchImpl })).resolves.toBe(
      true
    )
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2)
  })

  it('para na primeira página que responde: não gasta chamada à toa', async () => {
    const fetchImpl = vi.fn(async () => pagina([5])) as unknown as typeof fetch

    await usuarioAdministraInstalacao(5, { githubToken: 'tok', fetchImpl })

    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('FAIL-CLOSED: rede caída não vira permissão', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch

    await expect(
      usuarioAdministraInstalacao(1, { githubToken: 'tok', fetchImpl })
    ).rejects.toBeInstanceOf(InstalacaoNaoVerificavelError)
  })

  it('FAIL-CLOSED: HTTP não-ok (token revogado) não vira permissão', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
    ) as unknown as typeof fetch

    await expect(
      usuarioAdministraInstalacao(1, { githubToken: 'tok', fetchImpl })
    ).rejects.toBeInstanceOf(InstalacaoNaoVerificavelError)
  })

  it('FAIL-CLOSED: corpo em formato inesperado não vira permissão', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ installations: 'não é lista' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch

    await expect(
      usuarioAdministraInstalacao(1, { githubToken: 'tok', fetchImpl })
    ).rejects.toBeInstanceOf(InstalacaoNaoVerificavelError)
  })

  it('FAIL-CLOSED: lista sem fim (todas as páginas cheias) recusa por indisponibilidade', async () => {
    const cheia = Array.from({ length: 100 }, (_, i) => i + 1)
    const fetchImpl = vi.fn(async () => pagina(cheia)) as unknown as typeof fetch

    await expect(
      usuarioAdministraInstalacao(424242, { githubToken: 'tok', fetchImpl })
    ).rejects.toBeInstanceOf(InstalacaoNaoVerificavelError)
  })

  it('item sem id numérico é ignorado, não confundido com o id procurado', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ installations: [{ id: '42' }, { id: null }, {}] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch

    await expect(usuarioAdministraInstalacao(42, { githubToken: 'tok', fetchImpl })).resolves.toBe(
      false
    )
  })
})
