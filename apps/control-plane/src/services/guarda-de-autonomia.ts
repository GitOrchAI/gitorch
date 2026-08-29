import {
  exigirPermissao,
  NIVEL_PADRAO,
  type AcaoNoRepositorio,
  type NivelDeAutonomia,
} from '@gitorch/cadence'
import { fetchComTeto } from './fetch-com-teto.js'

/**
 * A PORTA: nenhuma escrita no repositório do cliente sai sem passar por aqui.
 *
 * A lição do SSRF, inteira: a guarda tem que ficar na SAÍDA DE REDE, não nos
 * chamadores. Guarda espalhada é guarda furada — basta um caminho novo esquecer
 * de perguntar e o produto escreve no repositório de quem não autorizou.
 *
 * Toda escrita do GitOrch no GitHub termina numa chamada `fetch` para
 * api.github.com: as mutations do quadro (Projects V2, via GraphQL) e as issues,
 * comentários e o merge (REST v3). Embrulhando o `fetch`, os dois caminhos
 * ficam cobertos pelo mesmo lugar.
 *
 * O que esta camada NÃO faz: decidir a política. Isso é do `podeEscrever`, em
 * packages/cadence — o mesmo veredito que os três motores enxergam.
 */

/** Só o que sai para o GitHub interessa; o resto passa direto. */
const HOSTS_DO_GITHUB = new Set(['api.github.com'])

/** Métodos que só leem. Qualquer outro é escrita até prova em contrário. */
const METODOS_DE_LEITURA = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Que família de ação é cada mutation do quadro.
 *
 * Só mutations aparecem aqui: uma `query` é leitura e nem chega a ser
 * consultada. O nome é o da operação GraphQL de verdade, conferido contra
 * packages/github-sync/src/project-v2-client.ts.
 */
const ACAO_DA_MUTATION: ReadonlyArray<{ operacao: RegExp; acao: AcaoNoRepositorio }> = [
  // Mexer no quadro: criar, ligar, mover item, mudar situação, sprint.
  { operacao: /createProjectV2\b/, acao: 'organizar' },
  { operacao: /linkProjectV2ToRepository\b/, acao: 'organizar' },
  { operacao: /createProjectV2Field\b/, acao: 'organizar' },
  { operacao: /updateProjectV2Field\b/, acao: 'organizar' },
  { operacao: /addProjectV2ItemById\b/, acao: 'organizar' },
  { operacao: /updateProjectV2ItemFieldValue\b/, acao: 'organizar' },
  { operacao: /archiveProjectV2Item\b/, acao: 'organizar' },
  { operacao: /createProjectV2StatusUpdate\b/, acao: 'organizar' },
  // Ligar uma issue como filha de outra é propor estrutura de trabalho.
  { operacao: /addSubIssue\b/, acao: 'propor' },
]

/**
 * Que família de ação é cada rota REST.
 *
 * A ordem importa: `mesclar` é testada ANTES de `propor`, porque o caminho do
 * merge também casa com o de pull request.
 */
const ACAO_DA_ROTA: ReadonlyArray<{ caminho: RegExp; acao: AcaoNoRepositorio }> = [
  // A mais forte do sistema: fechar o ciclo dentro do código do cliente.
  { caminho: /\/pulls\/\d+\/merge\b/, acao: 'mesclar' },
  { caminho: /\/pulls\/\d+\/(update-branch|reviews)\b/, acao: 'propor' },
  { caminho: /\/pulls\b/, acao: 'propor' },
  // Abrir e mexer em pedido, e falar no pedido.
  { caminho: /\/issues\/\d+\/comments\b/, acao: 'propor' },
  { caminho: /\/issues\/comments\/\d+\b/, acao: 'propor' },
  { caminho: /\/issues\/\d+\/(labels|assignees)\b/, acao: 'organizar' },
  { caminho: /\/issues\/\d+\b/, acao: 'propor' },
  { caminho: /\/issues\b/, acao: 'propor' },
  // Organização pura: rótulo e marco não propõem trabalho, arrumam o que há.
  { caminho: /\/labels\b/, acao: 'organizar' },
  { caminho: /\/milestones\b/, acao: 'organizar' },
]

/**
 * A ação de uma escrita que ninguém classificou.
 *
 * `mesclar` de propósito: é o degrau mais alto, então uma rota nova que
 * ninguém encaixou aqui só passa no nível "cuidar". O contrário — cair em
 * `propor`, ou pior, em `ler` — deixaria uma escrita desconhecida vazar no
 * nível errado, que é exatamente o defeito que esta camada existe para não ter.
 */
const ACAO_DO_DESCONHECIDO: AcaoNoRepositorio = 'mesclar'

/** Que ação uma requisição representa. Exportada porque o teste percorre ela. */
export function classificarRequisicao(input: {
  url: string
  metodo: string
  corpo?: string | null
}): AcaoNoRepositorio {
  if (METODOS_DE_LEITURA.has(input.metodo.toUpperCase())) return 'ler'

  const caminho = caminhoDa(input.url)

  // GraphQL: o corpo é que diz se lê ou escreve. Uma `query` chega por POST
  // como qualquer mutation, então olhar só o método classificaria toda leitura
  // do quadro como escrita.
  if (caminho === '/graphql') {
    const corpo = input.corpo ?? ''
    if (!pareceMutation(corpo)) return 'ler'
    const casada = ACAO_DA_MUTATION.find((m) => m.operacao.test(corpo))
    return casada?.acao ?? ACAO_DO_DESCONHECIDO
  }

  // Esta guarda governa o REPOSITÓRIO do cliente, e só ele. O que não é
  // /repos/... não é escrita no repositório dele: emitir token de instalação
  // (`POST /app/installations/N/access_tokens`), trocar código por token no
  // login, consultar conta ou organização. Tratar isso como escrita
  // desconhecida quebraria a emissão de credencial do produto inteiro — o
  // caminho por onde TUDO passa, inclusive a leitura.
  if (!/^\/repos\//.test(caminho)) return 'ler'

  const casada = ACAO_DA_ROTA.find((r) => r.caminho.test(caminho))
  return casada?.acao ?? ACAO_DO_DESCONHECIDO
}

/**
 * O corpo carrega uma mutation?
 *
 * Procura a palavra `mutation` como início de operação. Uma query que apenas
 * contenha o texto "mutation" dentro de uma string não deve ser tratada como
 * escrita — mas, se houver dúvida, o erro seguro é classificar como escrita,
 * porque escrita só é recusada, nunca executada por engano.
 */
function pareceMutation(corpo: string): boolean {
  return /(^|["\s\\n{])mutation[\s({]/.test(corpo)
}

function caminhoDa(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    // URL relativa não sai para o GitHub; devolver algo que não casa com nada
    // faz a classificação cair no desconhecido, que é o lado seguro.
    return url
  }
}

/** Se a chamada vai para o GitHub. Fora dele, esta guarda não opina. */
export function vaiParaOGithub(url: string): boolean {
  try {
    // Comparação EXATA de host. `startsWith`/`includes` deixariam passar
    // "api.github.com.dominio-alheio.tld" — o mesmo furo do SSRF.
    return HOSTS_DO_GITHUB.has(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * Embrulha um `fetch` para que TODA escrita no GitHub peça licença antes.
 *
 * `lerNivel` é função, e não valor, porque o dono pode mudar o nível pelo painel
 * no meio de uma varredura longa: a decisão tem que ser lida na hora da
 * chamada, não na hora em que o embrulho foi criado.
 *
 * Recusa vira `EscritaNaoAutorizadaError` (tipo próprio, de packages/cadence) e
 * NÃO uma resposta HTTP falsa: devolver um 403 fabricado faria o chamador achar
 * que falou com o GitHub e registrar um erro do GitHub que nunca existiu.
 */
export function guardaDeAutonomia(
  fetchImpl: typeof fetch,
  lerNivel: () => NivelDeAutonomia | null | undefined | string
): typeof fetch {
  // `async` de propósito: um `fetch` que LANÇA de forma síncrona quebra todo
  // chamador que escreve `fetch(...).catch(...)` — o `catch` nunca roda e a
  // exceção escapa por fora do fluxo de erro que o código já tem. Assim a
  // recusa chega como promessa rejeitada, do mesmo jeito que uma falha de rede.
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = urlDe(input)

    if (vaiParaOGithub(url)) {
      const metodo = (init?.method ?? metodoDe(input) ?? 'GET').toUpperCase()
      const acao = classificarRequisicao({ url, metodo, corpo: corpoDe(init) })
      // Lança quando não pode. Nada devolve booleano aqui de propósito: um
      // retorno dá para ignorar sem querer; uma exceção, não.
      exigirPermissao(lerNivel(), acao)
    }

    return fetchImpl(input, init)
  }) as typeof fetch
}

function urlDe(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url
}

function metodoDe(input: Parameters<typeof fetch>[0]): string | undefined {
  return typeof input === 'string' || input instanceof URL ? undefined : (input as Request).method
}

/**
 * O corpo, só quando ele já é texto.
 *
 * Um `Request` traz o corpo como fluxo, e lê-lo aqui o consumiria antes de a
 * chamada acontecer. Como todo caminho nosso passa o corpo como string em
 * `init.body`, isso cobre o que existe; um corpo que não seja texto cai no
 * desconhecido, que é o lado seguro.
 */
function corpoDe(init?: Parameters<typeof fetch>[1]): string | null {
  const body = init?.body
  return typeof body === 'string' ? body : null
}

/**
 * O `fetch` para falar com o repositório DE UM PROJETO.
 *
 * É a única forma sancionada de escrever no repositório do cliente: junta o
 * teto de tempo (que impede a varredura de travar) com a guarda de autonomia.
 * Quem precisa escrever passa isto adiante como `fetchImpl`.
 */
export function fetchDoRepositorio(args: {
  /** Nível do projeto, lido na hora da chamada. */
  nivel: () => NivelDeAutonomia | null | undefined | string
  /** Só os testes trocam; em produção é o `fetch` do runtime. */
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): typeof fetch {
  return fetchComTeto(guardaDeAutonomia(args.fetchImpl ?? fetch, args.nivel), args.timeoutMs)
}

/**
 * O padrão de quem NÃO passou um `fetch` com permissão.
 *
 * Existe por causa de um defeito de forma que estava em toda parte:
 * `options.fetchImpl ?? fetch` faz o esquecimento cair no `fetch` cru, ou
 * seja, escrever SEM guarda nenhuma. Quem esquece tem que falhar FECHADO.
 *
 * Aqui o esquecimento vira o nível mais restrito: leitura continua passando
 * (nada de quebrar tela de painel), e qualquer escrita é recusada com uma
 * mensagem que diz exatamente o que aconteceu.
 */
export function fetchSemPermissao(fetchImpl: typeof fetch = fetch): typeof fetch {
  return guardaDeAutonomia(fetchImpl, () => NIVEL_PADRAO)
}
