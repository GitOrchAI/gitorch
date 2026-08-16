import { mintInstallationToken } from './github-app-token.js'

/**
 * Prova de que um repositório declarado pelo cliente é REALMENTE dele.
 *
 * O wizard já pergunta ao GitHub quais repositórios o cliente alcança — é essa
 * lista que a tela de escolha exibe (`GET /api/v1/github/repos`). O que faltava
 * era cruzar: o passo final aceitava qualquer texto digitado, e um texto bem
 * formado com o endereço de outro cliente virava um projeto com o repositório
 * alheio gravado. Daí em diante o produto resolve a instalação do GitHub PELO
 * REPOSITÓRIO e passa a agir dentro da conta de quem nunca autorizou nada.
 *
 * Duas regras que este módulo não abre mão:
 *
 * 1. **Comparação exata e insensível a maiúsculas.** O GitHub trata
 *    `Dono/Repo` e `dono/repo` como o mesmo endereço, então comparar cru
 *    recusaria clientes legítimos. Mas a comparação é do endereço INTEIRO —
 *    nunca prefixo, nunca "contém": `vitima/repo` é prefixo de
 *    `vitima/repo-publico`, e um `startsWith` transformaria a guarda em porta.
 *
 * 2. **Não conseguir verificar NUNCA vira "pode tudo".** GitHub fora do ar,
 *    credencial ausente, lista grande demais para percorrer: tudo isso resolve
 *    em `RepositoriosNaoVerificaveisError`, e quem chama recusa o pedido. O
 *    caminho contrário — deixar passar quando a checagem falha — é o mesmo
 *    buraco com outra roupa.
 */

/** Não deu para saber o que o cliente acessa. Quem chama RECUSA — nunca aprova. */
export class RepositoriosNaoVerificaveisError extends Error {
  constructor(motivo: string) {
    super(`não foi possível verificar os repositórios do cliente: ${motivo}`)
    this.name = 'RepositoriosNaoVerificaveisError'
  }
}

const API_GITHUB = 'https://api.github.com'
const POR_PAGINA = 100
/**
 * Teto de páginas percorridas (100 por página = 5.000 repositórios). Existe para
 * a varredura não virar um laço infinito contra uma resposta estranha. Estourar
 * o teto NÃO libera nada: significa que não deu para afirmar a ausência, e o
 * resultado é a recusa por indisponibilidade.
 */
const TETO_DE_PAGINAS = 50
const TIMEOUT_MS = 10_000

export interface DependenciasDeAcesso {
  /** Instalação do GitHub App escolhida pelo cliente (`User.githubInstallationId`). */
  installationId?: number | null
  /** Token OAuth do próprio cliente (caminho clássico, sem App instalado). */
  githubToken?: string | null
  /** injeção para teste; default: fetch global */
  fetchImpl?: typeof fetch
  /** injeção para teste; default: mintInstallationToken */
  mintToken?: (args: { installationId: number }) => Promise<string | null>
}

/** Endereço comparável: sem espaços nas pontas e sem diferença de caixa. */
function normalizar(endereco: string): string {
  return endereco.trim().toLowerCase()
}

function cabecalhos(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch-control-plane',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

interface RepoDoGitHub {
  full_name?: unknown
}

/**
 * Percorre uma listagem paginada do GitHub riscando da lista de pendentes cada
 * endereço encontrado.
 *
 * Devolve `true` quando a varredura foi CONCLUSIVA — ou porque todos os
 * pendentes apareceram, ou porque a lista acabou (e o que sobrou de pendente
 * comprovadamente não está lá). Devolve `false` quando não deu para concluir
 * (erro de rede, HTTP não-ok, resposta com formato inesperado, teto de páginas):
 * aí quem chama tenta outro caminho ou recusa, nunca aprova.
 *
 * A varredura para assim que os pendentes zeram: o caso comum — o cliente
 * escolheu o repositório na lista que a própria tela mostrou — custa uma página.
 */
async function varrer(args: {
  pendentes: Map<string, string>
  url: (pagina: number) => string
  token: string
  extrair: (corpo: unknown) => RepoDoGitHub[] | null
  fetchImpl: typeof fetch
}): Promise<boolean> {
  for (let pagina = 1; pagina <= TETO_DE_PAGINAS; pagina++) {
    let itens: RepoDoGitHub[] | null
    try {
      const resposta = await args.fetchImpl(args.url(pagina), {
        headers: cabecalhos(args.token),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!resposta.ok) return false
      itens = args.extrair(await resposta.json())
    } catch {
      // Rede caída, timeout, JSON quebrado: inconclusivo. O `catch` não é vazio
      // — ele TRADUZ a falha em "não sei", que é o que fecha a porta lá em cima.
      return false
    }
    if (itens === null) return false

    for (const item of itens) {
      if (typeof item.full_name === 'string') {
        args.pendentes.delete(normalizar(item.full_name))
      }
    }
    if (args.pendentes.size === 0) return true
    // Página incompleta = fim da lista: o que ainda está pendente não existe
    // para este cliente.
    if (itens.length < POR_PAGINA) return true
  }
  return false
}

/**
 * Devolve os endereços declarados que o cliente NÃO alcança no GitHub.
 * Array vazio = todos conferidos e liberados.
 *
 * Mesma ordem de fontes que `GET /api/v1/github/repos` usa para montar a tela,
 * de propósito: a guarda tem que aprovar exatamente o que a tela ofereceu.
 * 1. Instalação do GitHub App, quando o cliente escolheu uma — é a lista mais
 *    estrita, só o que ELE marcou na tela do GitHub.
 * 2. Token OAuth do cliente, quando não há instalação usável.
 *
 * Lança `RepositoriosNaoVerificaveisError` se nenhuma fonte conseguiu responder.
 */
export async function repositoriosSemAcesso(
  declarados: string[],
  deps: DependenciasDeAcesso
): Promise<string[]> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const mintToken = deps.mintToken ?? ((args) => mintInstallationToken(args))

  // normalizado -> texto original, para a mensagem de erro citar o que o
  // cliente escreveu.
  const pendentes = new Map<string, string>()
  for (const declarado of declarados) {
    pendentes.set(normalizar(declarado), declarado)
  }
  if (pendentes.size === 0) return []

  if (deps.installationId) {
    const tokenDaInstalacao = await mintToken({ installationId: deps.installationId })
    if (tokenDaInstalacao) {
      const conclusiva = await varrer({
        pendentes,
        url: (pagina) =>
          `${API_GITHUB}/installation/repositories?per_page=${POR_PAGINA}&page=${pagina}`,
        token: tokenDaInstalacao,
        extrair: (corpo) => {
          const lista = (corpo as { repositories?: unknown })?.repositories
          return Array.isArray(lista) ? (lista as RepoDoGitHub[]) : null
        },
        fetchImpl,
      })
      if (conclusiva) return [...pendentes.values()]
      // Inconclusiva (App removido, API instável): cai no caminho OAuth abaixo,
      // igual ao que a listagem da tela já faz. O que NÃO acontece é seguir sem
      // verificar.
    }
  }

  if (!deps.githubToken) {
    throw new RepositoriosNaoVerificaveisError(
      'nenhuma credencial do GitHub disponível para listar os repositórios do cliente'
    )
  }

  const conclusiva = await varrer({
    pendentes,
    url: (pagina) => `${API_GITHUB}/user/repos?per_page=${POR_PAGINA}&sort=updated&page=${pagina}`,
    token: deps.githubToken,
    extrair: (corpo) => (Array.isArray(corpo) ? (corpo as RepoDoGitHub[]) : null),
    fetchImpl,
  })
  if (!conclusiva) {
    throw new RepositoriosNaoVerificaveisError(
      'a listagem de repositórios do GitHub não respondeu por completo'
    )
  }

  return [...pendentes.values()]
}
