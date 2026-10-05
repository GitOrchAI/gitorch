import { describe, expect, it, vi } from 'vitest'
import { resolverDefaultBranch, urlDoRepositorioNoGithub } from './default-branch-resolver.js'

describe('resolverDefaultBranch', () => {
  it('chama GET https://api.github.com/repos/{owner}/{repo} e retorna "master" quando default_branch é "master"', async () => {
    let chamadaUrl = ''
    let chamadaHeaders: Record<string, string> = {}

    const fetchImpl = vi.fn(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        chamadaUrl = String(input)
        chamadaHeaders = (init?.headers ?? {}) as Record<string, string>
        return new Response(
          JSON.stringify({
            name: 'autocandidata',
            full_name: 'GitOrchAI/autocandidata',
            default_branch: 'master',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      }
    ) as unknown as typeof fetch

    const branch = await resolverDefaultBranch({
      repoFullName: 'GitOrchAI/autocandidata',
      token: 'gho_teste_token',
      fetchImpl,
    })

    expect(branch).toBe('master')
    expect(chamadaUrl).toBe('https://api.github.com/repos/GitOrchAI/autocandidata')
    expect(chamadaHeaders['Authorization']).toBe('Bearer gho_teste_token')
    expect(chamadaHeaders['Accept']).toBe('application/vnd.github+json')
    expect(chamadaHeaders['User-Agent']).toBe('gitorch-control-plane')
  })

  it('retorna "main" quando a API do GitHub responde default_branch "main"', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          name: 'gitorch',
          full_name: 'GitOrchAI/gitorch',
          default_branch: 'main',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    }) as unknown as typeof fetch

    const branch = await resolverDefaultBranch({
      repoFullName: 'GitOrchAI/gitorch',
      fetchImpl,
    })

    expect(branch).toBe('main')
  })

  it('não envia header Authorization se o token não for fornecido', async () => {
    let chamadaHeaders: Record<string, string> = {}
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        chamadaHeaders = (init?.headers ?? {}) as Record<string, string>
        return new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    ) as unknown as typeof fetch

    const branch = await resolverDefaultBranch({
      repoFullName: 'public/repo',
      fetchImpl,
    })

    expect(branch).toBe('main')
    expect(chamadaHeaders['Authorization']).toBeUndefined()
  })

  it('devolve fallbackBranch se a requisição falhar com erro HTTP 404', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    }) as unknown as typeof fetch

    const branch = await resolverDefaultBranch({
      repoFullName: 'GitOrchAI/autocandidata',
      fallbackBranch: 'master',
      fetchImpl,
    })

    expect(branch).toBe('master')
  })

  it('devolve "main" como fallback padrão se a requisição falhar com HTTP 500 sem fallbackBranch explícito', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response('Internal Server Error', { status: 500 })
    }) as unknown as typeof fetch

    const branch = await resolverDefaultBranch({
      repoFullName: 'GitOrchAI/autocandidata',
      fetchImpl,
    })

    expect(branch).toBe('main')
  })

  it('devolve fallbackBranch se a requisição disparar exceção de rede', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed - Network connection refused')
    }) as unknown as typeof fetch

    const branch = await resolverDefaultBranch({
      repoFullName: 'GitOrchAI/autocandidata',
      fallbackBranch: 'master',
      fetchImpl,
    })

    expect(branch).toBe('master')
  })

  it('devolve fallbackBranch se a resposta não contiver default_branch string', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ default_branch: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const branch = await resolverDefaultBranch({
      repoFullName: 'GitOrchAI/autocandidata',
      fallbackBranch: 'trunk',
      fetchImpl,
    })

    expect(branch).toBe('trunk')
  })

  it('devolve fallbackBranch se repoFullName for inválido sem chamar a API', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    const branch = await resolverDefaultBranch({
      repoFullName: '../repo/invalido',
      fallbackBranch: 'master',
      fetchImpl,
    })

    expect(branch).toBe('master')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  describe('guarda na porta de saída (SSRF: a credencial nunca sai para outro destino)', () => {
    const maliciosos: Array<[string, string]> = [
      ['travessia com ..', 'dono/../repo'],
      ['travessia dupla', '../../evil'],
      ['barra a mais', 'dono/repo/extra'],
      ['sem barra', 'so-um-nome'],
      ['arroba', 'dono@evil.com/repo'],
      ['arroba no repo', 'dono/repo@evil.com'],
      ['dois-pontos', 'dono:8080/repo'],
      ['espaço', 'dono/re po'],
      ['barra codificada %2f', 'dono%2f..%2frepo/x'],
      ['percentual no repo', 'dono/repo%2fevil'],
      ['host no nome', 'evil.com/https://api.github.com/repo'],
      ['esquema de URL', 'https://evil.com/repo'],
      ['barra invertida', 'dono\\evil/repo'],
      ['quebra de linha', 'dono/repo\nHost: evil.com'],
      ['dono vazio', '/repo'],
      ['repo vazio', 'dono/'],
      ['vazio', ''],
      ['só ponto-ponto no repo', 'dono/..'],
    ]

    it.each(maliciosos)(
      '%s: devolve o fallback e NÃO chama o fetch',
      async (_nome, repoFullName) => {
        const fetchImpl = vi.fn() as unknown as typeof fetch

        const branch = await resolverDefaultBranch({
          repoFullName,
          token: 'gho_nao_pode_vazar',
          fallbackBranch: 'master',
          fetchImpl,
        })

        expect(branch).toBe('master')
        expect(fetchImpl).not.toHaveBeenCalled()
      }
    )

    it('nome válido chama exatamente https://api.github.com/repos/dono/repo com Authorization', async () => {
      const fetchImpl = vi.fn(
        async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
          new Response(JSON.stringify({ default_branch: 'develop' }), { status: 200 })
      )

      const branch = await resolverDefaultBranch({
        repoFullName: 'dono/repo.js_x-y',
        token: 'gho_teste',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })

      expect(branch).toBe('develop')
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
      expect(String(url)).toBe('https://api.github.com/repos/dono/repo.js_x-y')
      expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer gho_teste')
    })

    it('urlDoRepositorioNoGithub recusa host adulterado e protocolo que não é https', () => {
      expect(urlDoRepositorioNoGithub('dono/repo', 'https://evil.com')).toBeNull()
      expect(urlDoRepositorioNoGithub('dono/repo', 'https://api.github.com.evil.com')).toBeNull()
      expect(urlDoRepositorioNoGithub('dono/repo', 'http://api.github.com')).toBeNull()
      expect(urlDoRepositorioNoGithub('dono/repo', 'https://api.github.com:8443')).toBeNull()
      expect(urlDoRepositorioNoGithub('dono/repo', 'não é url')).toBeNull()
      expect(urlDoRepositorioNoGithub('dono/repo')?.href).toBe(
        'https://api.github.com/repos/dono/repo'
      )
    })
  })
})
