import { describe, expect, it, vi } from 'vitest'
import {
  repositoriosSemAcesso,
  RepositoriosNaoVerificaveisError,
} from './repositorios-do-usuario.js'

/**
 * Uma página de `GET /user/repos`. O `permissions` de cada item é o que o
 * GitHub devolve de verdade (docs REST, "List repositories for the
 * authenticated user"): `admin`, `maintain`, `push`, `triage`, `pull`. Aqui o
 * default é o do DONO — quem escreve —, porque é esse o caso dos testes que
 * falam de nome/paginação; os testes de permissão passam o objeto explícito.
 */
function pagina(nomes: string[]): Response {
  return new Response(
    JSON.stringify(nomes.map((full_name) => ({ full_name, permissions: PERMISSOES_DE_DONO }))),
    { status: 200 }
  )
}

const PERMISSOES_DE_DONO = { admin: true, maintain: true, push: true, triage: true, pull: true }
const PERMISSOES_DE_ESCRITA = {
  admin: false,
  maintain: false,
  push: true,
  triage: true,
  pull: true,
}
const PERMISSOES_DE_LEITURA = {
  admin: false,
  maintain: false,
  push: false,
  triage: false,
  pull: true,
}
const PERMISSOES_DE_TRIAGEM = {
  admin: false,
  maintain: false,
  push: false,
  triage: true,
  pull: true,
}

/** Página de `/user/repos` com o bloco de permissões escolhido item a item. */
function paginaComPermissoes(
  itens: Array<{ nome: string; permissoes?: Record<string, boolean> }>
): Response {
  return new Response(
    JSON.stringify(
      itens.map(({ nome, permissoes }) => ({
        full_name: nome,
        ...(permissoes ? { permissions: permissoes } : {}),
      }))
    ),
    { status: 200 }
  )
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

/**
 * "CONSIGO VER" NÃO É "SOU DONO".
 *
 * `GET /user/repos` devolve, por padrão (`affiliation` =
 * `owner,collaborator,organization_member`), tudo que a pessoa ENXERGA — o que
 * inclui repositório em que ela é colaboradora só-leitura e repositório da
 * organização a que ela pertence sem nenhum acesso de escrita. Aprovar por
 * aparecer na lista transformava a checagem de acesso numa PROMOÇÃO: logo
 * depois a esteira age com o token da INSTALAÇÃO, que escreve.
 *
 * O que separa um do outro está na própria resposta: o objeto `permissions`
 * de cada repositório.
 */
describe('repositoriosSemAcesso — enxergar não é poder escrever', () => {
  it('DONO (admin) é aprovado', async () => {
    const fetchImpl = vi.fn(async () =>
      paginaComPermissoes([{ nome: 'ana/api', permissoes: PERMISSOES_DE_DONO }])
    ) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['ana/api'], { githubToken: 'gho_ana', fetchImpl })
    ).resolves.toEqual([])
  })

  it('COLABORADOR COM ESCRITA (push) é aprovado', async () => {
    const fetchImpl = vi.fn(async () =>
      paginaComPermissoes([{ nome: 'time/api', permissoes: PERMISSOES_DE_ESCRITA }])
    ) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['time/api'], { githubToken: 'gho_ana', fetchImpl })
    ).resolves.toEqual([])
  })

  it('COLABORADOR SÓ-LEITURA é RECUSADO mesmo aparecendo na lista', async () => {
    const fetchImpl = vi.fn(async () =>
      paginaComPermissoes([{ nome: 'vitima/api', permissoes: PERMISSOES_DE_LEITURA }])
    ) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['vitima/api'], { githubToken: 'gho_mallory', fetchImpl })
    ).resolves.toEqual(['vitima/api'])
  })

  it('MEMBRO DA ORGANIZAÇÃO sem escrita (triagem) é RECUSADO', async () => {
    const fetchImpl = vi.fn(async () =>
      paginaComPermissoes([{ nome: 'acme/cofre', permissoes: PERMISSOES_DE_TRIAGEM }])
    ) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['acme/cofre'], { githubToken: 'gho_mallory', fetchImpl })
    ).resolves.toEqual(['acme/cofre'])
  })

  it('papel MAINTAIN (escreve, não administra) é aprovado', async () => {
    const fetchImpl = vi.fn(async () =>
      paginaComPermissoes([
        {
          nome: 'acme/api',
          permissoes: { admin: false, maintain: true, push: true, triage: true, pull: true },
        },
      ])
    ) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['acme/api'], { githubToken: 'gho_ana', fetchImpl })
    ).resolves.toEqual([])
  })

  it('resposta SEM o bloco de permissões não prova escrita: RECUSA', async () => {
    // Formato inesperado não vira "pode": sem o objeto `permissions` não há
    // como afirmar escrita, e "não sei" fecha a porta como em todo o resto
    // deste módulo.
    const fetchImpl = vi.fn(async () =>
      paginaComPermissoes([{ nome: 'ana/api' }])
    ) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['ana/api'], { githubToken: 'gho_ana', fetchImpl })
    ).resolves.toEqual(['ana/api'])
  })

  it('só-leitura não encerra a varredura cedo: a próxima página ainda é pedida', async () => {
    // O repositório só-leitura NÃO risca o pendente. Se riscasse, a varredura
    // terminaria achando que "já achou tudo" e o de verdade (na página 2)
    // nunca seria conferido.
    const primeira = Array.from({ length: 100 }, (_, i) => ({
      nome: i === 0 ? 'time/api' : `ana/repo-${i}`,
      permissoes: i === 0 ? PERMISSOES_DE_LEITURA : PERMISSOES_DE_DONO,
    }))
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('page=2')
        ? paginaComPermissoes([{ nome: 'time/api', permissoes: PERMISSOES_DE_ESCRITA }])
        : paginaComPermissoes(primeira)
    ) as unknown as typeof fetch

    // O mesmo endereço aparece duas vezes na conta do GitHub? Não — o caso real
    // aqui é a varredura não parar no primeiro encontro sem escrita.
    await expect(
      repositoriosSemAcesso(['time/api'], { githubToken: 'gho_ana', fetchImpl })
    ).resolves.toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('a lista da INSTALAÇÃO continua valendo por si: ela já é a autorização', async () => {
    // `GET /installation/repositories` não documenta bloco `permissions`, e não
    // precisa: entrar nessa lista exige que quem ADMINISTRA a conta tenha
    // marcado o repositório na tela de instalação do App. A escolha já é a
    // prova — exigir `permissions` aqui recusaria cliente legítimo.
    const fetchImpl = vi.fn(async () =>
      paginaDaInstalacao(['ana/autorizado'])
    ) as unknown as typeof fetch

    await expect(
      repositoriosSemAcesso(['ana/autorizado'], {
        installationId: 42,
        githubToken: 'gho_ana',
        fetchImpl,
        mintToken: async () => 'ghs_instalacao',
      })
    ).resolves.toEqual([])
  })
})
