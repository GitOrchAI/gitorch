import { describe, expect, it, vi } from 'vitest'
import { resolverDefaultBranch } from './default-branch-resolver.js'

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
})
