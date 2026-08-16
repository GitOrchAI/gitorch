import { describe, expect, it, vi } from 'vitest'
import {
  repositoriosSemAcesso,
  RepositoriosNaoVerificaveisError,
} from './repositorios-do-usuario.js'

function pagina(nomes: string[]): Response {
  return new Response(JSON.stringify(nomes.map((full_name) => ({ full_name }))), { status: 200 })
}

function paginaDaInstalacao(nomes: string[]): Response {
  return new Response(JSON.stringify({ repositories: nomes.map((full_name) => ({ full_name })) }), {
    status: 200,
  })
}

describe('repositoriosSemAcesso', () => {
  it('devolve o que não está na lista do cliente e nada do que está', async () => {
    const fetchImpl = vi.fn(async () => pagina(['ana/api', 'ana/site'])) as unknown as typeof fetch

    const semAcesso = await repositoriosSemAcesso(['ana/api', 'vitima/cofre'], {
      githubToken: 'gho_ana',
      fetchImpl,
    })

    expect(semAcesso).toEqual(['vitima/cofre'])
  })

  it('compara o endereço INTEIRO — prefixo e substring não autorizam', async () => {
    const fetchImpl = vi.fn(async () =>
      pagina(['vitima/cofre-publico', 'ana/o-cofre'])
    ) as unknown as typeof fetch

    const semAcesso = await repositoriosSemAcesso(['vitima/cofre'], {
      githubToken: 'gho_ana',
      fetchImpl,
    })

    expect(semAcesso).toEqual(['vitima/cofre'])
  })

  it('caixa diferente é o MESMO repositório para o GitHub, então libera', async () => {
    const fetchImpl = vi.fn(async () => pagina(['Ana/API'])) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['ana/api'], { githubToken: 'gho_ana', fetchImpl })
    ).resolves.toEqual([])
  })

  it('para de pedir páginas assim que todos os declarados aparecem', async () => {
    const cheia = Array.from({ length: 100 }, (_, i) => `ana/repo-${i}`)
    const fetchImpl = vi.fn(async () => pagina(cheia)) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['ana/repo-3'], { githubToken: 'gho_ana', fetchImpl })
    ).resolves.toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('lista sem fim (todas as páginas cheias) não vira aprovação — é indisponibilidade', async () => {
    // Uma resposta que nunca encolhe impediria concluir a ausência. O teto de
    // páginas corta o laço, e cortar NÃO pode significar "pode tudo".
    const cheia = Array.from({ length: 100 }, (_, i) => `ana/repo-${i}`)
    const fetchImpl = vi.fn(async () => pagina(cheia)) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['vitima/cofre'], { githubToken: 'gho_ana', fetchImpl })
    ).rejects.toBeInstanceOf(RepositoriosNaoVerificaveisError)
  })

  it('sem credencial nenhuma: indisponível, nunca liberado', async () => {
    await expect(repositoriosSemAcesso(['ana/api'], { githubToken: null })).rejects.toBeInstanceOf(
      RepositoriosNaoVerificaveisError
    )
  })

  it('HTTP não-ok do GitHub: indisponível, nunca liberado', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"message":"Bad credentials"}', { status: 401 })
    ) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['ana/api'], { githubToken: 'gho_expirado', fetchImpl })
    ).rejects.toBeInstanceOf(RepositoriosNaoVerificaveisError)
  })

  it('com instalação do App, a lista da instalação é a que vale', async () => {
    const fetchImpl = vi.fn(async () =>
      paginaDaInstalacao(['ana/autorizado'])
    ) as unknown as typeof fetch

    const semAcesso = await repositoriosSemAcesso(['ana/autorizado', 'ana/nao-autorizado'], {
      installationId: 42,
      githubToken: 'gho_ana',
      fetchImpl,
      mintToken: async () => 'ghs_instalacao',
    })

    expect(semAcesso).toEqual(['ana/nao-autorizado'])
    // Nem tocou no caminho OAuth: a instalação respondeu por completo.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain(
      '/installation/repositories'
    )
  })

  it('instalação inutilizável cai no caminho OAuth — verificando, não liberando', async () => {
    const fetchImpl = vi.fn(async () => pagina(['ana/api'])) as unknown as typeof fetch

    const semAcesso = await repositoriosSemAcesso(['ana/api'], {
      installationId: 42,
      githubToken: 'gho_ana',
      fetchImpl,
      // App revogado/não configurado: mintInstallationToken resolve em null.
      mintToken: async () => null,
    })

    expect(semAcesso).toEqual([])
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain(
      '/user/repos'
    )
  })

  it('instalação sem OAuth de reserva: indisponível em vez de liberar', async () => {
    await expect(
      repositoriosSemAcesso(['ana/api'], {
        installationId: 42,
        githubToken: null,
        mintToken: async () => null,
      })
    ).rejects.toBeInstanceOf(RepositoriosNaoVerificaveisError)
  })
})
