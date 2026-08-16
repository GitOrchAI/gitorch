import { nomeDeRepositorioValido } from './nome-de-repositorio.js'

/**
 * A PROVA ÚNICA de que o cliente pode ESCREVER num repositório do GitHub.
 *
 * Três rodadas de conserto vazaram pelo mesmo motivo: cada guarda fazia ao
 * GitHub uma pergunta INDIRETA e deduzia o acesso da resposta.
 *
 * - `GET /user/repos` traz, por padrão (`affiliation` = `owner,collaborator,
 *   organization_member`), tudo que a pessoa ENXERGA. Aprovar por aparecer ali
 *   é promoção de privilégio: logo em seguida a esteira age com o token da
 *   INSTALAÇÃO, que escreve.
 * - `GET /installation/repositories` é do APP (token assinado com a chave
 *   privada) e devolve TODOS os repositórios cobertos pela instalação da
 *   organização — inclusive os que aquele cliente não alcança. Colaboradora
 *   legítima de `acme/api` conseguia declarar `acme/segredos`.
 * - `GET /user/installations` responde as instalações que o usuário ENXERGA,
 *   não as que ele administra. Não prova posse de nada.
 *
 * A pergunta certa é direta, e é uma só:
 *
 *     GET https://api.github.com/repos/{dono}/{repositorio}
 *
 * com o token OAuth do PRÓPRIO CLIENTE. O bloco `permissions` da resposta é do
 * portador do token NAQUELE repositório — não uma lista onde ele possa estar
 * por qualquer motivo. Saída real, medida contra a API:
 *
 *     GitOrchAI/gitorch  -> {"admin":true,  "maintain":true,  "push":true,  ...}
 *     vercel/next.js     -> {"admin":false, "maintain":false, "push":false, ...}
 *     inexistente/nada   -> 404 {"message":"Not Found"}
 *
 * Uma chamada, exata, por repositório: sem paginação, sem afiliação, sem
 * instalação envenenável.
 *
 * Três regras que este módulo não abre mão:
 *
 * 1. **O token é o do CLIENTE, nunca a chave do App.** Com a chave do App a
 *    resposta seria "o que o App alcança" — a pergunta errada, que devolve sim
 *    para o ataque.
 *
 * 2. **`push === true` é a única régua.** `pull` sozinho é "consigo ver", e ver
 *    não autoriza o produto a escrever. `admin` e `maintain` sempre vêm com
 *    `push: true` na resposta do GitHub, então não precisam de linha própria —
 *    e uma combinação que o GitHub não emite continua recusada, de propósito.
 *
 * 3. **Não conseguir verificar NUNCA vira aprovação.** Rede caída, 5xx, corpo
 *    inesperado, `permissions` ausente: tudo resolve em
 *    `AcessoNaoVerificavelError`, e quem chama transforma isso em recusa
 *    temporária com motivo claro. O 404 é o único "não" definitivo que a API
 *    dá: o GitHub esconde repositório privado inacessível atrás dele, então
 *    404 é recusa limpa, não erro.
 */

/** Não deu para saber se o cliente escreve ali. Quem chama RECUSA — nunca aprova. */
export class AcessoNaoVerificavelError extends Error {
  constructor(motivo: string) {
    super(`não foi possível verificar o acesso do cliente ao repositório: ${motivo}`)
    this.name = 'AcessoNaoVerificavelError'
  }
}

const API_GITHUB = 'https://api.github.com'
const TIMEOUT_MS = 10_000

/**
 * Quantas provas correm ao mesmo tempo quando o lote é grande (a tela do
 * wizard chega a oferecer uma página inteira de repositórios). Baixo de
 * propósito: a API do GitHub pune rajada com limite secundário, e uma recusa
 * por rajada apareceria aqui como "não verificável" — ou seja, o cliente
 * legítimo pagaria por um excesso nosso.
 */
const PROVAS_SIMULTANEAS = 6

export interface DependenciasDeAcessoAoRepositorio {
  /** Token OAuth (user-to-server) do PRÓPRIO cliente — nunca a chave do App. */
  githubToken: string
  /** injeção para teste; default: fetch global */
  fetchImpl?: typeof fetch
}

function cabecalhos(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gitorch-control-plane',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/**
 * `true` só quando o GitHub confirma que o portador do token tem `push` neste
 * repositório. `false` para só-leitura e para 404 (inacessível ou inexistente:
 * o GitHub trata os dois igual, de propósito, para não revelar a existência de
 * repositório privado alheio).
 *
 * Lança `AcessoNaoVerificavelError` quando não deu para concluir.
 */
export async function podeEscreverNoRepositorio(
  nomeCompleto: string,
  deps: DependenciasDeAcessoAoRepositorio
): Promise<boolean> {
  // Primeiro a porta de FORMATO, antes de qualquer rede: o texto vai colado na
  // URL da API, e a normalização de URL resolveria `..` ANTES de a requisição
  // sair — trocando o endpoint que recebe a credencial (ver
  // services/nome-de-repositorio.ts). Recusa sem perguntar nada a ninguém.
  if (!nomeDeRepositorioValido(nomeCompleto)) return false

  const fetchImpl = deps.fetchImpl ?? fetch

  let resposta: Response
  try {
    resposta = await fetchImpl(`${API_GITHUB}/repos/${nomeCompleto}`, {
      headers: cabecalhos(deps.githubToken),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    // O `catch` não engole nada — ele TRADUZ a falha em "não sei", que é o que
    // fecha a porta lá em cima.
    throw new AcessoNaoVerificavelError(
      `a chamada ao GitHub falhou (${err instanceof Error ? err.message : String(err)})`
    )
  }

  // 404 é o "não" que a API sabe dar: repositório que não existe e repositório
  // privado que o portador do token não alcança respondem igual. Recusa limpa.
  if (resposta.status === 404) return false

  if (!resposta.ok) {
    throw new AcessoNaoVerificavelError(`o GitHub respondeu HTTP ${resposta.status}`)
  }

  let corpo: unknown
  try {
    corpo = await resposta.json()
  } catch {
    throw new AcessoNaoVerificavelError('a resposta do GitHub não era JSON')
  }

  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) {
    throw new AcessoNaoVerificavelError('a resposta do GitHub não era um repositório')
  }

  const permissoes = (corpo as { permissions?: unknown }).permissions
  if (typeof permissoes !== 'object' || permissoes === null || Array.isArray(permissoes)) {
    throw new AcessoNaoVerificavelError('a resposta do GitHub veio sem o bloco permissions')
  }

  // Comparação estrita com `true`: um `"true"` de texto, um `1`, ou qualquer
  // valor "verdadeiro" que não seja o booleano do GitHub NÃO é prova.
  return (permissoes as Record<string, unknown>)['push'] === true
}

/**
 * A LISTAGEM já respondeu? Então não se pergunta de novo.
 *
 * `GET /user/repos` devolve, em CADA item, o bloco `permissions` do portador
 * do token — a mesma informação que a prova direta busca, só que de graça:
 * uma chamada por página em vez de uma por repositório. Provar candidato a
 * candidato para MONTAR a tela custava 1 + N chamadas da cota do cliente (até
 * 101 para quem tem cem repositórios), a mesma cota que o clone, o
 * diagnóstico e a coleta de contexto consomem depois.
 *
 * A divisão de papéis é esta, e ela não pode inverter:
 *
 * - **a listagem monta a OFERTA** — o que a tela tem direito de mostrar;
 * - **a prova direta AUTORIZA** — e continua obrigatória no passo final
 *   (`POST /api/v1/setup/submit`), onde os repositórios são poucos e é ali que
 *   a autorização de fato acontece.
 *
 * O critério é o MESMO nos dois lados (`push === true`), de propósito: a tela
 * nunca oferece o que o passo final vai recusar.
 *
 * Só serve para listagem do PRÓPRIO CLIENTE. O bloco `permissions` de
 * `GET /installation/repositories` é do APP naquele repositório, não do
 * cliente — lê-lo como se fosse dele é justamente o buraco que deixava a
 * colaboradora de `acme/api` enxergar `acme/segredos`.
 *
 * Ausência de `permissions`, formato inesperado ou `push` que não seja o
 * booleano do GitHub: fora da oferta. Nada aqui aprova por suposição.
 */
export function escreveSegundoAListagem(item: unknown): boolean {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
  const permissoes = (item as { permissions?: unknown }).permissions
  if (typeof permissoes !== 'object' || permissoes === null || Array.isArray(permissoes)) {
    return false
  }
  return (permissoes as Record<string, unknown>)['push'] === true
}

/**
 * Aplica a prova a um lote e devolve os endereços que o cliente NÃO pode
 * escrever, com o texto ORIGINAL que ele digitou (a mensagem de erro cita o
 * que ele escreveu, não uma versão normalizada).
 *
 * Lança `AcessoNaoVerificavelError` se QUALQUER um do lote for inverificável:
 * aprovar os demais e calar sobre esse seria decidir no escuro. Um lote
 * duplicado só custa uma chamada por endereço distinto.
 */
export async function repositoriosSemEscrita(
  declarados: string[],
  deps: DependenciasDeAcessoAoRepositorio
): Promise<string[]> {
  if (declarados.length === 0) return []

  // Distintos por comparação insensível a caixa: o GitHub trata `Dono/Repo` e
  // `dono/repo` como o mesmo endereço, e perguntar duas vezes o mesmo só gasta
  // limite de API.
  const porEndereco = new Map<string, string>()
  for (const declarado of declarados) {
    const chave = declarado.trim().toLowerCase()
    if (!porEndereco.has(chave)) porEndereco.set(chave, declarado)
  }

  const originais = [...porEndereco.values()]
  const aprovados = await emLotes(originais, (nome) => podeEscreverNoRepositorio(nome, deps))
  return originais.filter((_, indice) => aprovados[indice] !== true)
}

/**
 * Roda a prova em ondas de `PROVAS_SIMULTANEAS`, preservando a ordem das
 * respostas. Uma falha propaga (é o que fecha a porta); as provas já
 * disparadas na mesma onda terminam antes, e nenhuma nova onda começa.
 */
async function emLotes<T, R>(itens: T[], executar: (item: T) => Promise<R>): Promise<R[]> {
  const resultados: R[] = []
  for (let inicio = 0; inicio < itens.length; inicio += PROVAS_SIMULTANEAS) {
    const onda = itens.slice(inicio, inicio + PROVAS_SIMULTANEAS)
    resultados.push(...(await Promise.all(onda.map(executar))))
  }
  return resultados
}

/** O mínimo que a prova precisa do cofre de credenciais do produto. */
export interface LeitorDeTokenDoDono {
  getRawGithubToken(userId: string): Promise<string | null>
}

/**
 * A MESMA prova, montada para o momento do USO — não só o do cadastro.
 *
 * O acesso era provado uma vez, no wizard; o endereço virava `project.wingId`
 * e nunca mais era conferido. Se a organização remove a pessoa depois, o
 * projeto continua ativo apontando para repositório alheio, e o produto
 * escreve lá com a credencial da instalação. Por isso as portas que registram
 * um desejo reconferem antes de escrever.
 *
 * Sem cofre montado, ou sem credencial do dono, o resultado é
 * `AcessoNaoVerificavelError` — indisponibilidade é recusa temporária, nunca
 * permissão.
 */
export function provaDeEscritaNoUso(
  leitor: LeitorDeTokenDoDono | undefined,
  fetchImpl?: typeof fetch
): (repo: string, userId: string) => Promise<boolean> {
  return async (repo, userId) => {
    if (!leitor) {
      throw new AcessoNaoVerificavelError('o serviço de credenciais do GitHub não está disponível')
    }

    let token: string | null
    try {
      token = await leitor.getRawGithubToken(userId)
    } catch (err) {
      throw new AcessoNaoVerificavelError(
        `não foi possível ler a credencial do GitHub do dono (${err instanceof Error ? err.message : String(err)})`
      )
    }
    if (!token) {
      throw new AcessoNaoVerificavelError('o dono não tem credencial do GitHub conectada')
    }

    return podeEscreverNoRepositorio(repo, {
      githubToken: token,
      ...(fetchImpl ? { fetchImpl } : {}),
    })
  }
}
