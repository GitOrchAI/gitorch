// L4-T8 — a REDE DE SEGURANÇA do "quadro 100%".
//
// MEDIDO em 02/09/2026 no gitorch: 52 issues abertas, 44 no quadro, 8 fora.
// O anexo na hora da criação (desejo-no-github.ts, incidente, board-status.ts)
// é o PRIMEIRO elo — mas é best-effort, e best-effort às vezes falha (rede,
// board sem quadro resolvido naquele instante, corrida). Esta varredura é o
// SEGUNDO elo: periodicamente relê TODAS as issues abertas do repositório e
// pendura no quadro qualquer uma que ainda não esteja lá, não importa quem a
// criou (desejo, incidente, humano, bot, o próprio dono).
//
// Paginada com teto — nunca gira para sempre num repositório absurdo — e
// gated por autonomia: só roda em `sugerir`/`cuidar`. `so_olhar` nem tenta LER
// a lista de issues, e não é a guarda de escrita (guarda-de-autonomia.ts) que
// segura isto — é ANTES dela, de propósito: assim um projeto em "só olhar"
// nunca aparece tentando e nunca conta "falha" por causa da recusa.

import type { GqlDoGithub } from './anexar-ao-quadro.js'

export interface NoDeIssueAberta {
  id: string
  number: number
  projectItems?: { nodes?: Array<{ project?: { id?: string } }> }
}

export interface ConexaoDeIssuesAbertas {
  nodes?: NoDeIssueAberta[]
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
}

export interface PaginaDeIssuesAbertas {
  repository?: {
    issues?: ConexaoDeIssuesAbertas
  }
}

export interface DepsDaVarreduraDeQuadro {
  /** "dono/nome" — usado para montar a consulta e para todo log. */
  repositorio: string
  /** Node id do quadro (Projects v2) JÁ resolvido — esta varredura não escolhe quadro. */
  projectId: string
  /** Nível de autonomia REAL do projeto — escrita só roda em sugerir/cuidar. */
  nivelDeAutonomia: string | null | undefined
  gql: GqlDoGithub
  /** Pendura UMA issue no quadro (tipicamente `anexarAoQuadro` por baixo). */
  anexarAoQuadro: (issueNodeId: string) => Promise<unknown>
  /** Teto de páginas desta passada — nunca sem limite (mil issues = 10 páginas de 100). */
  tetoDePaginas?: number
  onInfo?: (mensagem: string) => void
  onWarn?: (mensagem: string) => void
}

export interface ResultadoDaVarreduraDeQuadro {
  repo: string
  abertas: number
  fora: number
  anexadas: number
  falhas: number
}

/** 10 páginas de 100 = mil issues abertas por repositório — teto generoso. */
export const TETO_DE_PAGINAS_DA_VARREDURA = 10
const ITENS_POR_PAGINA = 100

const QUERY_ISSUES_ABERTAS = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      issues(states: OPEN, first: ${ITENS_POR_PAGINA}, after: $after) {
        nodes {
          id
          number
          projectItems(first: 20) { nodes { project { id } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

/** Os únicos dois níveis em que o produto pode ESCREVER no repositório do cliente. */
const NIVEIS_QUE_ESCREVEM = new Set(['sugerir', 'cuidar'])

/**
 * Varre as issues abertas de UM repositório e pendura no quadro as que ainda
 * não estão lá.
 *
 * Nunca lança: um repositório que falhar no meio (rede, GitHub fora do ar)
 * devolve o que já contou até ali — quem chama decide se tenta de novo no
 * próximo tique. Uma issue que falha ao anexar NÃO para as outras da mesma
 * passada; a falha vira `onWarn` e conta em `falhas`.
 */
export async function varrerIssuesForaDoQuadro(
  deps: DepsDaVarreduraDeQuadro
): Promise<ResultadoDaVarreduraDeQuadro> {
  const info = deps.onInfo ?? ((): void => undefined)
  const warn = deps.onWarn ?? ((): void => undefined)
  const resultado: ResultadoDaVarreduraDeQuadro = {
    repo: deps.repositorio,
    abertas: 0,
    fora: 0,
    anexadas: 0,
    falhas: 0,
  }

  if (!NIVEIS_QUE_ESCREVEM.has(deps.nivelDeAutonomia ?? '')) {
    info(`[Scheduler] quadro ${deps.repositorio}: autonomia "só olhar" — varredura não escreve.`)
    return resultado
  }

  const [owner, name] = deps.repositorio.split('/')
  const teto = deps.tetoDePaginas ?? TETO_DE_PAGINAS_DA_VARREDURA

  let after: string | null = null
  for (let pagina = 0; pagina < teto; pagina++) {
    const data: PaginaDeIssuesAbertas = await deps.gql<PaginaDeIssuesAbertas>(
      QUERY_ISSUES_ABERTAS,
      { owner, name, after }
    )
    const conexao: ConexaoDeIssuesAbertas | undefined = data.repository?.issues
    if (!conexao) break

    for (const issue of conexao.nodes ?? []) {
      resultado.abertas += 1
      const jaNoQuadro = (issue.projectItems?.nodes ?? []).some(
        (n: { project?: { id?: string } }) => n.project?.id === deps.projectId
      )
      if (jaNoQuadro) continue

      resultado.fora += 1
      try {
        await deps.anexarAoQuadro(issue.id)
        resultado.anexadas += 1
      } catch (err) {
        resultado.falhas += 1
        warn(
          `[Scheduler] quadro ${deps.repositorio}: falha ao anexar issue #${issue.number} (${String(err).slice(0, 120)})`
        )
      }
    }

    if (!conexao.pageInfo?.hasNextPage) break
    after = conexao.pageInfo.endCursor ?? null
  }

  info(
    `[Scheduler] quadro ${deps.repositorio}: ${resultado.fora} fora, ${resultado.anexadas} anexadas, ${resultado.falhas} falhas`
  )
  return resultado
}
