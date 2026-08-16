/**
 * Prova de que uma instalação do GitHub App declarada pelo cliente é REALMENTE
 * dele.
 *
 * `users.github_installation_id` não é um campo qualquer: é a AUTORIDADE que o
 * passo final do wizard consulta para responder "quais repositórios são deste
 * cliente?" (services/repositorios-do-usuario.ts). E o token daquela instalação
 * é emitido com a chave privada do App — que abre QUALQUER instalação, não só a
 * de quem pediu. Ou seja: quem consegue escrever um id alheio nesta coluna passa
 * a ser comparado contra a lista de repositórios da vítima, e a guarda que
 * deveria barrar o projeto alheio o aprova.
 *
 * O retorno da tela de instalação do GitHub traz `installation_id` na query, e
 * query é texto do cliente. O `state` assinado que acompanha prova apenas que
 * quem voltou é quem saiu (anti-CSRF) — não diz nada sobre de quem é a
 * instalação. A única fonte que sabe é o próprio GitHub, perguntado com o token
 * do CLIENTE: `GET /user/installations` lista as instalações do nosso App que o
 * usuário autenticado tem permissão de acessar.
 *
 * Duas regras que este módulo não abre mão:
 *
 * 1. **A pergunta vai com o token do cliente, nunca com a chave do App.** Com a
 *    chave do App a resposta seria "todas as instalações que existem" — a
 *    pergunta errada, que devolve sim para o ataque.
 *
 * 2. **Não conseguir verificar NUNCA vira "pode".** GitHub fora do ar, token
 *    revogado, corpo em formato inesperado: tudo resolve em
 *    `InstalacaoNaoVerificavelError`, e quem chama recusa sem gravar. Deixar
 *    passar quando a checagem falha é o mesmo buraco com outra roupa.
 */

/** Não deu para saber de quem é a instalação. Quem chama RECUSA — nunca aprova. */
export class InstalacaoNaoVerificavelError extends Error {
  constructor(motivo: string) {
    super(`não foi possível verificar a instalação do GitHub do cliente: ${motivo}`)
    this.name = 'InstalacaoNaoVerificavelError'
  }
}

const API_GITHUB = 'https://api.github.com'
const POR_PAGINA = 100
/**
 * Teto de páginas percorridas (100 por página = 10.000 instalações). Existe para
 * a varredura não virar laço infinito contra uma resposta estranha. Estourar o
 * teto NÃO libera nada: vira recusa por indisponibilidade.
 */
const TETO_DE_PAGINAS = 10
const TIMEOUT_MS = 10_000

export interface DependenciasDeInstalacao {
  /** Token OAuth (user-to-server) do PRÓPRIO cliente — nunca a chave do App. */
  githubToken: string
  /** injeção para teste; default: fetch global */
  fetchImpl?: typeof fetch
}

interface InstalacaoDoGitHub {
  id?: unknown
}

/**
 * `true` quando o cliente comprovadamente administra a instalação informada;
 * `false` quando a lista dele foi percorrida por inteiro e a instalação não está
 * lá. Lança `InstalacaoNaoVerificavelError` quando não deu para concluir.
 *
 * A varredura para na primeira página que contém o id: o caso comum — a pessoa
 * acabou de instalar e tem uma ou duas instalações — custa uma chamada.
 */
export async function usuarioAdministraInstalacao(
  installationId: number,
  deps: DependenciasDeInstalacao
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch

  for (let pagina = 1; pagina <= TETO_DE_PAGINAS; pagina++) {
    let resposta: Response
    try {
      resposta = await fetchImpl(
        `${API_GITHUB}/user/installations?per_page=${POR_PAGINA}&page=${pagina}`,
        {
          headers: {
            Authorization: `Bearer ${deps.githubToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'gitorch-control-plane',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }
      )
    } catch (err) {
      // Rede caída ou timeout: inconclusivo. O `catch` não engole nada — ele
      // TRADUZ a falha em "não sei", que é o que fecha a porta lá em cima.
      throw new InstalacaoNaoVerificavelError(
        `a chamada ao GitHub falhou (${err instanceof Error ? err.message : String(err)})`
      )
    }

    if (!resposta.ok) {
      throw new InstalacaoNaoVerificavelError(`o GitHub respondeu HTTP ${resposta.status}`)
    }

    let corpo: unknown
    try {
      corpo = await resposta.json()
    } catch {
      throw new InstalacaoNaoVerificavelError('a resposta do GitHub não era JSON')
    }

    const lista = (corpo as { installations?: unknown })?.installations
    if (!Array.isArray(lista)) {
      throw new InstalacaoNaoVerificavelError('a resposta do GitHub veio sem a lista installations')
    }

    for (const item of lista as InstalacaoDoGitHub[]) {
      // Comparação numérica estrita: o id chega da query como texto e já foi
      // convertido por quem chama. Um `==` frouxo aqui aceitaria formas
      // esquisitas do mesmo número vindas da API.
      if (typeof item.id === 'number' && item.id === installationId) return true
    }

    // Página incompleta = fim da lista: a instalação comprovadamente não é dele.
    if (lista.length < POR_PAGINA) return false
  }

  throw new InstalacaoNaoVerificavelError(
    'a lista de instalações do cliente é grande demais para percorrer por inteiro'
  )
}
