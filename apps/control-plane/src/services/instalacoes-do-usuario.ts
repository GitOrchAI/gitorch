/**
 * O que o GitHub confirma sobre a instalação do App que o cliente declarou —
 * e, com igual importância, o que ele NÃO confirma.
 *
 * O que esta rota responde, exatamente: `GET /user/installations` lista as
 * instalações do nosso App ACESSÍVEIS ao token do usuário. É o que ele
 * ENXERGA. Um membro comum de uma organização enxerga a instalação dela sem
 * administrar coisa alguma — então aparecer nesta lista NÃO é prova de posse,
 * e nada neste produto pode tratá-la como se fosse. Foi exatamente esse tipo
 * de dedução (deduzir acesso de uma listagem) que abriu três buracos seguidos.
 *
 * Quem prova acesso é outra pergunta, direta e por repositório:
 * `GET /repos/{dono}/{repo}` com o token do próprio cliente, onde
 * `permissions.push === true` autoriza (services/acesso-ao-repositorio.ts).
 * Toda porta que grava ou usa um repositório passa por lá.
 *
 * Então para que esta guarda continua servindo? Para uma coisa só, e ela é
 * real: `users.github_installation_id` decide de QUAL instalação o produto
 * mintará um token com a CHAVE PRIVADA DO APP (routes/setup.ts,
 * `candidatosViaInstalacao`). A chave abre qualquer instalação; sem esta
 * porteira, bastava chamar o callback com o id de outra pessoa para o produto
 * emitir credencial sobre a instalação dela e puxar a lista de repositórios
 * dela para a memória. Os nomes alheios não chegam mais à tela — a prova por
 * repositório os corta —, mas emitir a credencial já é um passo que não nos
 * cabe dar a pedido de estranho.
 *
 * Duas regras que este módulo não abre mão:
 *
 * 1. **A pergunta vai com o token do cliente, nunca com a chave do App.** Com
 *    a chave do App a resposta seria "todas as instalações que existem" — a
 *    pergunta errada, que devolve sim para o ataque.
 *
 * 2. **Não conseguir verificar NUNCA vira "pode".** GitHub fora do ar, token
 *    revogado, corpo em formato inesperado: tudo resolve em
 *    `InstalacaoNaoVerificavelError`, e quem chama recusa sem gravar.
 */

/** Não deu para saber se o cliente enxerga a instalação. Quem chama RECUSA. */
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
 * `true` quando a instalação informada aparece na lista do próprio cliente —
 * ou seja, ele a ENXERGA; `false` quando a lista dele foi percorrida por
 * inteiro e a instalação não está lá. Lança `InstalacaoNaoVerificavelError`
 * quando não deu para concluir.
 *
 * Leia o nome ao pé da letra: enxergar não é administrar, e muito menos
 * autoriza repositório. É porteira de mint, não autoridade de acesso.
 *
 * A varredura para na primeira página que contém o id: o caso comum — a pessoa
 * acabou de instalar e tem uma ou duas instalações — custa uma chamada.
 */
export async function usuarioEnxergaInstalacao(
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

    // Página incompleta = fim da lista: ele comprovadamente não enxerga esta
    // instalação.
    if (lista.length < POR_PAGINA) return false
  }

  throw new InstalacaoNaoVerificavelError(
    'a lista de instalações do cliente é grande demais para percorrer por inteiro'
  )
}
