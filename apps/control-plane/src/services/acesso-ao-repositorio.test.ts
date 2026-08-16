import { describe, expect, it, vi } from 'vitest'
import {
  podeEscreverNoRepositorio,
  repositoriosSemEscrita,
  provaDeEscritaNoUso,
  escreveSegundoAListagem,
  AcessoNaoVerificavelError,
} from './acesso-ao-repositorio.js'

/**
 * O defeito que estes testes fecham: todas as guardas anteriores faziam ao
 * GitHub uma pergunta INDIRETA e deduziam o acesso da resposta.
 *
 * - `GET /user/repos` devolve, por padrão, tudo que a pessoa ENXERGA
 *   (colaboradora, membro da organização) — aprovar por aparecer ali promove
 *   privilégio;
 * - `GET /installation/repositories` é do APP, e devolve TODOS os repositórios
 *   cobertos pela instalação da organização, inclusive os que aquele cliente
 *   não alcança;
 * - `GET /user/installations` responde o que o usuário ENXERGA, não o que ele
 *   administra.
 *
 * A pergunta direta é uma só: `GET /repos/{dono}/{repositorio}` com o token do
 * PRÓPRIO cliente. O bloco `permissions` da resposta é do portador do token
 * naquele repositório, e `push === true` é a prova de escrita.
 */

/** Resposta real do GitHub para quem administra o repositório. */
const COMO_DONO = { admin: true, maintain: true, push: true, triage: true, pull: true }
/** Resposta real do GitHub para quem só consegue LER (ex.: vercel/next.js). */
const SO_LEITURA = { admin: false, maintain: false, push: false, triage: false, pull: true }

function respostaDeRepo(permissions: unknown): Response {
  return new Response(JSON.stringify({ full_name: 'acme/api', permissions }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('podeEscreverNoRepositorio', () => {
  it('APROVA quando o GitHub diz que o portador do token tem push', async () => {
    const fetchImpl = vi.fn(async () => respostaDeRepo(COMO_DONO)) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('acme/api', { githubToken: 'gho_do_cliente', fetchImpl })
    ).resolves.toBe(true)
  })

  it('RECUSA quem só consegue LER — enxergar não é poder escrever', async () => {
    const fetchImpl = vi.fn(async () => respostaDeRepo(SO_LEITURA)) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('vercel/next.js', { githubToken: 'gho_do_cliente', fetchImpl })
    ).resolves.toBe(false)
  })

  it('RECUSA quando o GitHub responde 404 — repositório inacessível é escondido, não é erro', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    ) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('vitima/segredos', { githubToken: 'gho_do_cliente', fetchImpl })
    ).resolves.toBe(false)
  })

  it('pergunta EXATAMENTE pelo repositório declarado, com o token do CLIENTE', async () => {
    const fetchImpl = vi.fn(async () => respostaDeRepo(COMO_DONO)) as unknown as typeof fetch

    await podeEscreverNoRepositorio('GitOrchAI/gitorch', {
      githubToken: 'gho_do_cliente',
      fetchImpl,
    })

    const chamada = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(chamada?.[0])).toBe('https://api.github.com/repos/GitOrchAI/gitorch')
    const headers = chamada?.[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer gho_do_cliente')
  })

  it('5xx do GitHub NÃO vira aprovação: erro de "não verificável"', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"message":"Server Error"}', { status: 500 })
    ) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('acme/api', { githubToken: 'gho', fetchImpl })
    ).rejects.toBeInstanceOf(AcessoNaoVerificavelError)
  })

  it('rede caída NÃO vira aprovação: erro de "não verificável"', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up')
    }) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('acme/api', { githubToken: 'gho', fetchImpl })
    ).rejects.toBeInstanceOf(AcessoNaoVerificavelError)
  })

  it('corpo SEM o bloco permissions é "não verificável", nunca "pode"', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ full_name: 'acme/api' }), { status: 200 })
    ) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('acme/api', { githubToken: 'gho', fetchImpl })
    ).rejects.toBeInstanceOf(AcessoNaoVerificavelError)
  })

  it('permissions que não é objeto (formato inesperado) é "não verificável"', async () => {
    const fetchImpl = vi.fn(async () => respostaDeRepo('tudo')) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('acme/api', { githubToken: 'gho', fetchImpl })
    ).rejects.toBeInstanceOf(AcessoNaoVerificavelError)
  })

  it('resposta que não é JSON é "não verificável"', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>proxy</html>', { status: 200 })
    ) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('acme/api', { githubToken: 'gho', fetchImpl })
    ).rejects.toBeInstanceOf(AcessoNaoVerificavelError)
  })

  it('nome fora do formato "dono/repositorio" é recusado SEM tocar a rede', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('../../user/repos?', { githubToken: 'gho', fetchImpl })
    ).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('push:false com admin:true não existe no GitHub, mas se vier, a régua continua sendo push', async () => {
    // Defesa contra corpo inesperado: a régua é UMA — `push === true`. Qualquer
    // outra coisa recusa, inclusive combinações que o GitHub não emite.
    const fetchImpl = vi.fn(async () =>
      respostaDeRepo({ admin: true, maintain: true, push: false, triage: true, pull: true })
    ) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('acme/api', { githubToken: 'gho', fetchImpl })
    ).resolves.toBe(false)
  })

  it('push com valor que não é booleano (string "true") NÃO aprova', async () => {
    const fetchImpl = vi.fn(async () => respostaDeRepo({ push: 'true' })) as unknown as typeof fetch

    await expect(
      podeEscreverNoRepositorio('acme/api', { githubToken: 'gho', fetchImpl })
    ).resolves.toBe(false)
  })
})

/**
 * A LISTAGEM monta a oferta; a PROVA autoriza. São dois papéis diferentes, e
 * é por isso que existem duas funções — mas o CRITÉRIO é o mesmo (`push ===
 * true`), para a tela nunca oferecer o que o passo final vai recusar.
 *
 * `GET /user/repos` já devolve, item a item, o bloco `permissions` do portador
 * do token. Ler dali custa zero chamada extra; provar um a um custava uma
 * chamada por repositório da cota do cliente.
 */
describe('escreveSegundoAListagem', () => {
  it('aceita o item da listagem em que o portador do token tem push', () => {
    expect(escreveSegundoAListagem({ permissions: COMO_DONO })).toBe(true)
  })

  it('recusa quem só lê — a régua é a mesma da prova direta', () => {
    expect(escreveSegundoAListagem({ permissions: SO_LEITURA })).toBe(false)
  })

  it('item SEM o bloco permissions não entra na oferta (não se supõe escrita)', () => {
    expect(escreveSegundoAListagem({ full_name: 'acme/api' })).toBe(false)
  })

  it('push que não é o booleano do GitHub não vale como prova', () => {
    expect(escreveSegundoAListagem({ permissions: { push: 'true' } })).toBe(false)
    expect(escreveSegundoAListagem({ permissions: { push: 1 } })).toBe(false)
  })

  it('permissions em formato inesperado (lista, texto, nulo) recusa em vez de quebrar', () => {
    expect(escreveSegundoAListagem({ permissions: ['push'] })).toBe(false)
    expect(escreveSegundoAListagem({ permissions: 'push' })).toBe(false)
    expect(escreveSegundoAListagem({ permissions: null })).toBe(false)
    expect(escreveSegundoAListagem(null)).toBe(false)
  })
})

describe('repositoriosSemEscrita', () => {
  function fetchPorRepo(porNome: Record<string, unknown>): typeof fetch {
    return vi.fn(async (url: string | URL | Request) => {
      const nome = String(url).replace('https://api.github.com/repos/', '')
      const permissoes = porNome[nome]
      if (permissoes === undefined) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      }
      return respostaDeRepo(permissoes)
    }) as unknown as typeof fetch
  }

  it('lote inteiro com escrita devolve lista vazia', async () => {
    const fetchImpl = fetchPorRepo({ 'acme/api': COMO_DONO, 'acme/web': COMO_DONO })

    await expect(
      repositoriosSemEscrita(['acme/api', 'acme/web'], { githubToken: 'gho', fetchImpl })
    ).resolves.toEqual([])
  })

  it('devolve, com o texto que o cliente digitou, o que ele não pode escrever', async () => {
    const fetchImpl = fetchPorRepo({ 'acme/api': COMO_DONO, 'vitima/cofre': SO_LEITURA })

    await expect(
      repositoriosSemEscrita(['acme/api', 'vitima/cofre'], { githubToken: 'gho', fetchImpl })
    ).resolves.toEqual(['vitima/cofre'])
  })

  it('um repositório inverificável derruba o lote inteiro (nunca aprova por omissão)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('acme/api')
        ? respostaDeRepo(COMO_DONO)
        : new Response('{"message":"Server Error"}', { status: 500 })
    ) as unknown as typeof fetch

    await expect(
      repositoriosSemEscrita(['acme/api', 'acme/web'], { githubToken: 'gho', fetchImpl })
    ).rejects.toBeInstanceOf(AcessoNaoVerificavelError)
  })

  it('lista vazia não pergunta nada ao GitHub', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    await expect(repositoriosSemEscrita([], { githubToken: 'gho', fetchImpl })).resolves.toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('provaDeEscritaNoUso', () => {
  it('lê o token do dono e responde a prova daquele repositório', async () => {
    const fetchImpl = vi.fn(async () => respostaDeRepo(COMO_DONO)) as unknown as typeof fetch
    const getRawGithubToken = vi.fn().mockResolvedValue('gho_do_dono')

    const prova = provaDeEscritaNoUso({ getRawGithubToken }, fetchImpl)

    await expect(prova('acme/api', 'user_1')).resolves.toBe(true)
    expect(getRawGithubToken).toHaveBeenCalledWith('user_1')
  })

  it('sem credencial do dono não dá para verificar — e "não sei" nunca vira "pode"', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const prova = provaDeEscritaNoUso({ getRawGithubToken: async () => null }, fetchImpl)

    await expect(prova('acme/api', 'user_1')).rejects.toBeInstanceOf(AcessoNaoVerificavelError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('sem o serviço de credenciais montado, também é "não verificável"', async () => {
    const prova = provaDeEscritaNoUso(undefined)
    await expect(prova('acme/api', 'user_1')).rejects.toBeInstanceOf(AcessoNaoVerificavelError)
  })

  it('falha ao ler a credencial (cofre corrompido) é "não verificável", não recusa silenciosa', async () => {
    const prova = provaDeEscritaNoUso({
      getRawGithubToken: async () => {
        throw new Error('envelope corrompido')
      },
    })

    await expect(prova('acme/api', 'user_1')).rejects.toBeInstanceOf(AcessoNaoVerificavelError)
  })
})
