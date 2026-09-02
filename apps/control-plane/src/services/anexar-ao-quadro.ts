// L4-T8 — helper ÚNICO de "pendurar uma issue no quadro (Projects v2)".
//
// Extraído de `board-status.ts` (`createCardMover`): a MESMA lógica idempotente
// vivia duplicada em pelo menos DOIS lugares (aqui e em `github-backlog.ts`,
// `addToBoard`) — cada chamador reescrevendo o próprio try/catch de "Content
// already exists in this project". Agora qualquer caminho que precise anexar
// uma issue recém-nascida ao quadro (desejo, incidente, varredura periódica,
// o movedor de card) chama isto, uma vez só.
//
// A idempotência importa porque o GitHub tem automação PRÓPRIA de auto-add em
// alguns boards: a issue pode já estar lá quando o produto tenta anexar, e
// "já existe" não é falha — é reencontrar o item que já está no board CERTO
// (por isso o `project.id` do item devolvido é conferido contra o `projectId`
// pedido: "já existe" em OUTRO quadro não é a mesma coisa e tem que relançar).

import { GithubExecutionError } from './github-errors.js'

/** Só o que este helper usa de `ProjectV2Client` — nunca a classe inteira. */
export interface AnexarAoQuadroClient {
  addItemById(args: { projectId: string; contentId: string }): Promise<string>
}

/** Um `gql` ad-hoc: uma consulta, os dados já desembrulhados. */
export type GqlDoGithub = <T = unknown>(
  query: string,
  variables: Record<string, unknown>
) => Promise<T>

export interface AnexarAoQuadroDeps {
  client: AnexarAoQuadroClient
  gql: GqlDoGithub
  /**
   * Seta a coluna inicial do item recém-anexado (ex.: "Todo"). Best-effort do
   * lado de QUEM CHAMA — ausente ou `statusInicial` ausente = nunca é chamado
   * (o item nasce sem coluna, o board decide o resto).
   */
  setStatus?: (itemId: string, status: string) => Promise<string>
}

export interface AnexarAoQuadroArgs {
  projectId: string
  issueNodeId: string
  statusInicial?: string
}

export interface ResultadoDoAnexo {
  itemId: string
  /** Só presente quando `statusInicial` E `deps.setStatus` existem os dois. */
  statusResultado?: string
}

const MENSAGEM_DE_JA_EXISTE = 'already exists'

/**
 * Pendura `issueNodeId` no quadro `projectId`.
 *
 * Caminho feliz: uma mutation. "Já existe": reencontra o item pelo `node(id)`
 * → `projectItems` da issue, filtrando pelo `projectId` pedido — item de OUTRO
 * quadro não conta, e o erro original sobe intacto. Qualquer outro erro
 * (rede, permissão) propaga sem tentar reencontrar nada: mascarar uma falha
 * real de "já existe" é o defeito que esta função existe para não ter.
 */
export async function anexarAoQuadro(
  args: AnexarAoQuadroArgs,
  deps: AnexarAoQuadroDeps
): Promise<ResultadoDoAnexo> {
  let itemId: string
  try {
    itemId = await deps.client.addItemById({
      projectId: args.projectId,
      contentId: args.issueNodeId,
    })
  } catch (error) {
    if (!String(error).includes(MENSAGEM_DE_JA_EXISTE)) throw error

    const data = await deps.gql<{
      node?: { projectItems?: { nodes?: Array<{ id: string; project?: { id?: string } }> } }
    }>(
      `query($id: ID!) { node(id: $id) { ... on Issue {
        projectItems(first: 20) { nodes { id project { id } } } } } }`,
      { id: args.issueNodeId }
    )
    const item = data.node?.projectItems?.nodes?.find((n) => n.project?.id === args.projectId)
    if (!item) throw error
    itemId = item.id
  }

  if (args.statusInicial && deps.setStatus) {
    const statusResultado = await deps.setStatus(itemId, args.statusInicial)
    return { itemId, statusResultado }
  }
  return { itemId }
}

/**
 * Fábrica do `gql` ad-hoc que este módulo (e quem o chama) precisa: um POST
 * para `/graphql` com o MESMO tratamento de erro em todo lugar que hoje fala
 * com a API do quadro — `errors[]` nunca vira sucesso silencioso.
 *
 * Existe para não reescrever o mesmo parse+checagem em cada chamador
 * (`desejo-no-github.ts`, a varredura periódica, `board-status.ts`) — a lição
 * do SSRF de novo: lógica repetida é lógica que diverge sozinha.
 */
export function criarGqlDoGithub(f: typeof fetch, token: string): GqlDoGithub {
  return async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const resp = await f('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'gitorch',
      },
      body: JSON.stringify({ query, variables }),
    })
    const json = (await resp.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (json.errors?.length) {
      throw new GithubExecutionError(`GitHub GraphQL failed: ${json.errors[0]?.message}`)
    }
    if (!json.data) throw new GithubExecutionError('GitHub GraphQL returned no data')
    return json.data
  }
}
